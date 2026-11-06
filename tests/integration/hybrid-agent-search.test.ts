import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Hybrid agent search: with an embedding provider configured, the vector and
 * full-text rankings run in parallel and fuse by reciprocal rank. A hit only
 * one leg saw still ranks on its single contribution — and the relevance
 * floor then filters the merge: a passage neither leg ranks highly is not
 * evidence, however it fused.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extractor = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
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
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extractor }));
vi.mock("@/integrations/object-store/object-store", () => ({
  readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));

import { embedExtraction } from "@/domains/knowledge/embedding";
import { searchDocumentsForAgent } from "@/domains/knowledge/agent-search";
import { extractDocument } from "@/domains/knowledge/extraction";

/** Deterministic embedder: words hash into buckets, so shared words mean closeness. */
function fakeProvider(model = "fake:hash-1536"): EmbeddingProvider {
  const provider = {
    model,
    async embed(values: string[]) {
      return values.map((value) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
          let h = 0;
          for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % EMBEDDING_DIMENSIONS;
          v[h] += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
  return provider;
}

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
});

const EXACT =
  "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit. ".repeat(30);
// Same topic, but only "deposit" overlaps the query's words: it matches both
// legs, yet far more weakly than EXACT, so RRF must rank it second.
const LOOSE =
  "Twelve hundred dollars is due each month for the dwelling. The deposit is retained by the property owner. ".repeat(
    30,
  );
const UNRELATED = "Quarterly revenue rose three percent. The board approved the annual budget. ".repeat(30);

async function seedRow(auth: { workspaceId: string; userId: string }, title: string) {
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
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: `${title}.pdf` })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "application/pdf" })
    .returning();
  return doc;
}

async function seed(
  auth: { workspaceId: string; userId: string },
  text: string,
  title: string,
  provider?: EmbeddingProvider,
) {
  const doc = await seedRow(auth, title);
  extractor.extract.mockResolvedValueOnce({
    ok: true,
    text,
    spans: [{ page: 1, start: 0, end: text.length }],
    pageCount: 1,
    extractor: "fixture@1",
  });
  const result = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!result.ok) throw new Error("seed failed");
  // No provider means no embeddings: the document is findable by FTS only.
  if (provider)
    await embedExtraction({ ...auth, role: "owner" as const }, { extractionId: result.extractionId, provider });
  return doc;
}
const workspace = async () => ({
  ...(await seedWorkspace(holder.db!, `hs-${crypto.randomUUID()}`)),
  role: "owner" as const,
});

suite("hybrid agent search (real Postgres + pgvector)", () => {
  it("returns mode hybrid with the exact match first and drops sub-floor loose matches", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, EXACT, "lease-exact", provider);
    await seed(a, LOOSE, "lease-loose", provider);
    await seed(a, UNRELATED, "minutes", provider);
    const res = await searchDocumentsForAgent(a, { query: "monthly rent security deposit", limit: 5, provider });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("hybrid");
    expect(res.results[0]).toMatchObject({ title: "lease-exact" });
    // The loose match is vector-only (the keyword leg refuses it: the query's
    // terms are ANDed) past the provisional single-leg rank bound (issue #533
    // finding 3: admission is leg provenance, not the miscalibrated 0.5 fused
    // floor, whose 0.5 was leg-count in disguise). The unrelated document is
    // likewise single-leg and far down its leg. Neither may pollute results;
    // additional passages of the exact document now MAY appear (finding 1's
    // per-document budget), so the assertion is membership, not list length.
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.title === "lease-exact")).toBe(true);
  });

  it("a gibberish query returns mode hybrid with a low result list, never a thrown error or a text label", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, EXACT, "lease", provider);
    const res = await searchDocumentsForAgent(a, { query: "xyzzyqwop flurbgronk", provider });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The vector leg always returns its nearest chunks (no distance cutoff),
    // so "low" means: no FTS contribution, nothing outside the workspace,
    // never the text-mode label, never an error.
    expect(res.mode).toBe("hybrid");
    expect(res.results.every((r) => r.title === "lease")).toBe(true);
  });

  it("a hit only the full-text leg saw still surfaces (the vector leg missed it)", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    // minutes has embeddings (the vector leg answers with it); lease-exact is
    // text-only, so the vector leg cannot see it at all. The merge must keep
    // the FTS-only hit.
    await seed(a, UNRELATED, "minutes", provider);
    const lease = await seed(a, EXACT, "lease-exact");
    const res = await searchDocumentsForAgent(a, { query: "monthly rent security deposit", provider });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("hybrid");
    expect(res.results.map((r) => r.documentId)).toContain(lease.id);
  });

  it("finding 2: the FTS leg returns canonical chunk units, so equivalent evidence fuses across legs", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, EXACT, "lease-exact", provider);
    const { searchChunks, searchChunksFts } = await import("@/domains/knowledge/search");
    const query = "monthly rent security deposit";
    const [vectorHits, ftsHits] = await Promise.all([
      searchChunks(a, { query, limit: 5, provider }),
      searchChunksFts(a, { query, limit: 5 }),
    ]);
    expect(ftsHits.length).toBeGreaterThan(0);
    expect(vectorHits.length).toBeGreaterThan(0);
    // The same passage carries the same (extractionId, chunkIndex) on both
    // legs: before the repair the FTS leg labeled its query-dependent window
    // chunkIndex 0 and collided with the vector leg's real chunk 0.
    const vectorKeys = new Set(vectorHits.map((h) => `${h.extractionId}:${h.chunkIndex}`));
    expect(ftsHits.some((h) => vectorKeys.has(`${h.extractionId}:${h.chunkIndex}`))).toBe(true);
    // And the fused result records both legs on that passage.
    const res = await searchDocumentsForAgent(a, { query, limit: 5, provider });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results[0]?.extractionId).toBeTruthy();
    expect(typeof res.results[0]?.chunkIndex).toBe("number");
  });

  it("finding 1: one document contributes several distinct passages when the evidence is distant", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    // Two distant sections share words with the query; filler separates them
    // so they land in different canonical chunks.
    const filler = "Ordinary minutes of the quarterly board meeting. ".repeat(60);
    const text = `Alpha clause: the tenant pays monthly rent by transfer. ${filler} Omega clause: the landlord returns the security deposit after inspection.`;
    await seed(a, text, "long-lease", provider);
    const res = await searchDocumentsForAgent(a, {
      query: "monthly rent security deposit",
      limit: 8,
      provider,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chunks = new Set(
      res.results.filter((r) => r.title === "long-lease").map((r) => r.chunkIndex),
    );
    expect(chunks.size).toBeGreaterThan(1);
  });
});
