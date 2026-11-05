import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documentEnrichment, documents, files, artifactLinks, artifacts, zettelProposals } from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-174/ASH-184: the enrichment state machine. After extraction succeeds,
 * embed -> zettels -> link advance in order, each stage visible and
 * retryable, a failure stopping the line instead of losing the document.
 * The zettels stage creates cards directly — the extraction that fed it was
 * the permission — and the link stage embeds the document's cards off their
 * `source` edges, not any proposal status.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extract = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extract }));
vi.mock("@/integrations/object-store/object-store", () => ({ readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { advanceDocumentEnrichment, getDocumentEnrichment, retryDocumentEnrichment } from "@/domains/knowledge/enrichment";
import { extractDocument } from "@/domains/knowledge/extraction";
import { createZettelFromSource } from "@/domains/knowledge/zettels";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";

const TEXT = "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit until move out. Pets are not allowed without written consent.";
const zettels = (): ZettelExtractor => ({
  name: "fake@1",
  extract: async () => [{ title: "Monthly rent", content: "Rent is $1,200 a month.", quote: "The tenant pays monthly rent of twelve hundred dollars." }],
});
const vec = (d: number) => { const v = new Array(1536).fill(0); v[d] = 1; return v; };
const embedding: EmbeddingProvider = { model: "fake-embed@1", embed: async (values) => values.map(() => vec(7)) };

beforeAll(() => {
  holder.db = handle?.db;
  // Embedding keys unset for the whole suite: the create-time near-duplicate
  // gate must degrade to unfiltered creation here, the way it does for a
  // workspace with no provider configured, and never reach for the network.
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture"); });

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `en-${crypto.randomUUID()}`), role: "owner" as const });
async function seedDoc(auth: { workspaceId: string; userId: string }) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({ workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(), sizeBytes: 4, mimeType: "application/pdf" }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title: "lease", fileId: file.id, mimeType: "application/pdf" }).returning();
  extract.extract.mockResolvedValueOnce({ ok: true, text: TEXT, spans: [{ page: 1, start: 0, end: TEXT.length }], pageCount: 1, extractor: "fixture@1" });
  const r = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!r.ok) throw new Error("seed failed");
  return doc;
}

/** The document's zettel cards, read off their `source` edges — what the link stage consumes. */
async function docCards(documentId: string) {
  const db = holder.db!;
  return db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .where(
      and(
        eq(artifactLinks.targetType, "document"),
        eq(artifactLinks.targetId, documentId),
        eq(artifactLinks.linkType, "source"),
        eq(artifacts.kind, "zettel"),
      ),
    );
}

const stages = (rows: Array<{ stage: string; status: string }>) => Object.fromEntries(rows.map((r) => [r.stage, r.status]));

suite("document enrichment state machine (real Postgres)", () => {
  it("records a visible failed stage when no provider is configured, and the document is not lost", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth); // extraction hook advances the pipeline with no providers
    const rows = await getDocumentEnrichment(auth, doc.id);
    const state = stages(rows);
    expect(state.extract).toBe("succeeded");
    expect(state.embed).toBe("failed"); // visible, not silent
    expect(state.zettels).toBe("pending"); // the line stops, later stages wait
    const embed = rows.find((r) => r.stage === "embed")!;
    expect(embed.lastError).toContain("No embedding provider");
    expect(embed.attempts).toBe(1);
  });

  it("advance runs embed then zettels then link in order, idempotently", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    const providers = { embedding, zettels: zettels() };

    const rows = await advanceDocumentEnrichment(auth, { documentId: doc.id, providers });
    expect(stages(rows)).toEqual({ extract: "succeeded", embed: "succeeded", zettels: "succeeded", link: "succeeded" });
    const cards = await docCards(doc.id);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Monthly rent");
    const proposals = await holder.db!.select({ id: zettelProposals.id }).from(zettelProposals).where(eq(zettelProposals.documentId, doc.id));
    expect(proposals).toHaveLength(0);

    // A second advance is a no-op: no new cards, no new attempts on succeeded
    // stages (the link stage re-embeds; embedArtifact is idempotent per card).
    const again = await advanceDocumentEnrichment(auth, { documentId: doc.id, providers });
    expect(stages(again)).toEqual({ extract: "succeeded", embed: "succeeded", zettels: "succeeded", link: "succeeded" });
    const cardsAfter = await docCards(doc.id);
    expect(cardsAfter).toHaveLength(1);
  });

  it("the link stage embeds the document's cards — including ones added after the zettels stage ran", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    await advanceDocumentEnrichment(auth, { documentId: doc.id, providers: { embedding, zettels: zettels() } });

    const first = await docCards(doc.id);
    expect(first).toHaveLength(1);
    const { embeddings } = await import("@/domains/knowledge/schema");
    const embedded = async (artifactId: string) =>
      holder.db!.select().from(embeddings).where(and(
        eq(embeddings.workspaceId, auth.workspaceId),
        eq(embeddings.ownerType, "artifact"),
        eq(embeddings.ownerId, artifactId),
      ));

    // The zettels stage's card was embedded by the link stage in the same advance.
    expect((await embedded(first[0].id)).length).toBeGreaterThan(0);

    // A card added later by another surface (a reading-summary accept, say)
    // is invisible to the last link pass — the re-run picks it up.
    const later = await createZettelFromSource(auth, {
      source: { kind: "document", documentId: doc.id },
      title: "Deposit protection",
      content: "The landlord keeps the security deposit until the tenant moves out.",
      quote: "The landlord keeps the security deposit until move out.",
      span: { start: TEXT.indexOf("The landlord keeps"), end: TEXT.indexOf("The landlord keeps") + "The landlord keeps the security deposit until move out.".length },
      proposer: "test:reading-summary",
    });
    if ("skipped" in later) throw new Error("later card creation unexpectedly skipped");
    await advanceDocumentEnrichment(auth, { documentId: doc.id, providers: { embedding, zettels: zettels() } });

    expect((await embedded(later.artifactId)).length).toBeGreaterThan(0);
  });

  it("retry reruns a failed stage and the line then advances", async () => {
    const auth = await workspace();
    const doc = await seedDoc(auth);
    let state = stages(await getDocumentEnrichment(auth, doc.id));
    expect(state.embed).toBe("failed");

    const rows = await retryDocumentEnrichment(auth, { documentId: doc.id, providers: { embedding, zettels: zettels() } });
    state = stages(rows);
    expect(state).toEqual({ extract: "succeeded", embed: "succeeded", zettels: "succeeded", link: "succeeded" });
    const embed = rows.find((r) => r.stage === "embed")!;
    expect(embed.attempts).toBe(2);
    expect(embed.lastError).toBeNull();
  });

  it("stage rows are workspace-scoped", async () => {
    const auth = await workspace();
    const other = await workspace();
    const doc = await seedDoc(auth);
    await advanceDocumentEnrichment(auth, { documentId: doc.id, providers: { embedding, zettels: zettels() } });
    const foreign = await holder.db!.select().from(documentEnrichment).where(and(
      eq(documentEnrichment.workspaceId, other.workspaceId),
      eq(documentEnrichment.documentId, doc.id),
    ));
    expect(foreign).toHaveLength(0);
  });
});
