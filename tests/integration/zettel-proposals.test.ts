import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { artifacts, claimEvidence, claims, concepts, documents, files, sources } from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Direct creation honesty (real Postgres): the trigger is the acceptance, so
 * the card that lands must already be honest — the quote verbatim in its
 * section, the span exact, the provenance rows written, the capacity cap
 * respected, and a second identical run skipped by the same-span gate.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extract = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extract }));
vi.mock("@/integrations/object-store/object-store", () => ({
  readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));

import { extractDocument } from "@/domains/knowledge/extraction";
import { createZettelsFromSource, zettelDedupeKey } from "@/domains/knowledge/zettels";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const TEXT =
  "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit until move out. Pets are not allowed without written consent.";
const Q1 = "The tenant pays monthly rent of twelve hundred dollars.";
const Q2 = "The landlord keeps the security deposit until move out.";
const extractor = (cands: Array<{ title: string; content: string; quote: string }>): ZettelExtractor => ({
  name: "fake@1",
  extract: async () => cands,
});
beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
});

const workspace = async () => ({
  ...(await seedWorkspace(holder.db!, `zt-${crypto.randomUUID()}`)),
  role: "owner" as const,
});
async function seed(auth: { workspaceId: string; userId: string }, text = TEXT, succeed = true) {
  const db = holder.db!;
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "application/pdf",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: "lease", fileId: file.id, mimeType: "application/pdf" })
    .returning();
  if (succeed) {
    extract.extract.mockResolvedValueOnce({
      ok: true,
      text,
      spans: [{ page: 1, start: 0, end: text.length }],
      pageCount: 1,
      extractor: "fixture@1",
    });
    const r = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
    if (!r.ok) throw new Error("seed failed");
  }
  return doc;
}

/** The card's dedupe key and verbatim span, from its metadata. */
async function cardSpan(artifactId: string) {
  const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, artifactId));
  const meta = card.metadata as { dedupeKey?: string } | null;
  if (!meta?.dedupeKey) throw new Error("card has no dedupeKey");
  const [, , sourcePart, spanPart] = meta.dedupeKey.split(":");
  const [start, end] = spanPart.split("-").map(Number);
  return { card, key: meta.dedupeKey, sourcePart, start, end };
}

suite("createZettelsFromSource honesty (real Postgres)", () => {
  it("creates cards with verbatim spans and document provenance", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor([
        { title: "Monthly rent", content: "Rent is $1,200 a month.", quote: Q1 },
        { title: "Deposit", content: "The landlord holds the deposit until move out.", quote: Q2 },
      ]),
    });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ artifactId: expect.any(String), title: "Monthly rent" });

    const { card, key, sourcePart, start, end } = await cardSpan(created[0]!.artifactId);
    expect(card.kind).toBe("zettel");
    expect(TEXT.slice(start, end)).toBe(Q1);
    expect(key).toBe(zettelDedupeKey("doc", doc.id, start, end));
    expect(sourcePart).toBe(doc.id);
  });

  it("drops invented quotes, empty fields and short quotes", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor([
        { title: "Invented", content: "x", quote: "The tenant may keep a dragon in the flat." },
        { title: "", content: "no title", quote: Q1 },
        { title: "Short", content: "short", quote: "rent" },
        { title: "Real", content: "real", quote: Q2 },
      ]),
    });
    expect(created.map((c) => c.title)).toEqual(["Real"]);
  });

  it("keeps negation verbatim: a paraphrase that drops the 'not' never lands", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor([
        { title: "Pets allowed", content: "Pets are allowed.", quote: "Pets are allowed without written consent." },
        {
          title: "No pets",
          content: "Pets need written consent.",
          quote: "Pets are not allowed without written consent.",
        },
      ]),
    });
    expect(created.map((c) => c.title)).toEqual(["No pets"]);
    const { start, end } = await cardSpan(created[0]!.artifactId);
    expect(TEXT.slice(start, end)).toBe("Pets are not allowed without written consent.");
  });

  it("needs a succeeded extraction and a document in the caller's workspace", async () => {
    const auth = await workspace();
    const other = await workspace();
    const pending = await seed(auth, TEXT, false);
    await expect(
      createZettelsFromSource(auth, { documentId: pending.id, extractor: extractor([]) }),
    ).rejects.toThrow("no succeeded extraction");
    const doc = await seed(auth);
    await expect(
      createZettelsFromSource(other, { documentId: doc.id, extractor: extractor([]) }),
    ).rejects.toThrow("not found in workspace");
  });

  it("caps cards per document by source size", async () => {
    const auth = await workspace();
    // The per-source bound is size-derived now (capForSize): this source is
    // ~1.2k chars, so the small band caps it at 2 — the flat 20 is gone.
    const sentences = Array.from({ length: 25 }, (_, i) => `Clause number ${i} states a distinct obligation.`);
    const doc = await seed(auth, sentences.join(" "));
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor(sentences.map((q, i) => ({ title: `T${i}`, content: "c", quote: q }))),
    });
    expect(created).toHaveLength(2);
  });

  it("caps a medium single-section source at 5 without a merge", async () => {
    const auth = await workspace();
    // ~11k chars, one section (under the 12k section cap): the medium band
    // applies — 25 located candidates, the final slice keeps 5.
    const sentences = Array.from(
      { length: 25 },
      (_, i) => `Clause number ${i} ${"padding text ".repeat(30)}states a distinct obligation.`,
    );
    expect(sentences.join(" ").length).toBeGreaterThan(2_000);
    expect(sentences.join(" ").length).toBeLessThanOrEqual(12_000);
    const doc = await seed(auth, sentences.join(" "));
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor(sentences.map((q, i) => ({ title: `T${i}`, content: "c", quote: q }))),
    });
    expect(created).toHaveLength(5);
  });

  it("a second identical run lands on the same-span gate and creates nothing more", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const pass = {
      documentId: doc.id,
      extractor: extractor([{ title: "Rent", content: "c", quote: Q1 }]),
    };
    const first = await createZettelsFromSource(auth, pass);
    expect(first.created).toHaveLength(1);

    const again = await createZettelsFromSource(auth, pass);
    expect(again.created).toEqual([]);
    expect(again.skippedSpans).toBe(1);
    const cards = await holder.db!.select().from(artifacts).where(eq(artifacts.workspaceId, auth.workspaceId));
    expect(cards).toHaveLength(1);
  });

  it("two sources with the same term reuse the concept", async () => {
    const auth = await workspace();
    const d1 = await seed(auth);
    const d2 = await seed(auth);
    const mk = (id: string) =>
      createZettelsFromSource(auth, {
        documentId: id,
        extractor: extractor([{ title: "Monthly rent", content: "c", quote: Q1 }]),
      });
    const first = await mk(d1.id);
    const second = await mk(d2.id);

    const [claimA] = await holder
      .db!.select()
      .from(claims)
      .where(eq(claims.artifactId, first.created[0]!.artifactId));
    const [claimB] = await holder
      .db!.select()
      .from(claims)
      .where(eq(claims.artifactId, second.created[0]!.artifactId));
    // Concept reuse is keyed by (workspace, term, sense): both cards share it.
    expect(claimB.id).not.toBe(claimA.id);
    expect((await holder.db!.select().from(concepts).where(eq(concepts.workspaceId, auth.workspaceId))).length).toBe(1);
    expect((await holder.db!.select().from(claims).where(eq(claims.workspaceId, auth.workspaceId))).length).toBe(2);
  });

  it("the evidence row pins the exact span in the extraction", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor([{ title: "Monthly rent", content: "Rent is $1,200 a month.", quote: Q1 }]),
    });

    const [claim] = await holder
      .db!.select()
      .from(claims)
      .where(eq(claims.artifactId, created[0]!.artifactId));
    const [concept] = await holder
      .db!.select()
      .from(concepts)
      .where(and(eq(concepts.workspaceId, auth.workspaceId), eq(concepts.term, "Monthly rent")));
    expect(concept).toMatchObject({ term: "Monthly rent", definition: "Rent is $1,200 a month.", sourceQuote: Q1 });
    const [ev] = await holder.db!.select().from(claimEvidence).where(eq(claimEvidence.claimId, claim.id));
    expect(ev.quote).toBe(Q1);
    const { start, end } = await cardSpan(created[0]!.artifactId);
    expect(ev.startOffset).toBe(start);
    expect(ev.endOffset).toBe(end);
    const [src] = await holder.db!.select().from(sources).where(eq(sources.id, ev.sourceId));
    expect(src).toMatchObject({ kind: "document", title: "lease" });
  });

  it("creation is audited: one zettel.created row naming the card", async () => {
    const auth = await workspace();
    const doc = await seed(auth);
    const { created } = await createZettelsFromSource(auth, {
      documentId: doc.id,
      extractor: extractor([{ title: "Monthly rent", content: "Rent is $1,200 a month.", quote: Q1 }]),
    });

    const audits = await holder
      .db!.select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, created[0]!.artifactId));
    expect(audits.map((r) => r.action)).toEqual(["zettel.created"]);
    expect(audits[0]!.summary).toBe('Created zettel "Monthly rent"');
  });
});
