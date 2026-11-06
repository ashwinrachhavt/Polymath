import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documentExtractions, documents, embeddings, files } from "@/domains/knowledge/schema";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extractor = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extractor }));
vi.mock("@/integrations/object-store/object-store", () => ({ readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { embedExtraction } from "@/domains/knowledge/embedding";
import { extractDocument } from "@/domains/knowledge/extraction";
import { searchChunks } from "@/domains/knowledge/search";

/** Deterministic embedder: words hash into buckets, so shared words mean closeness. */
function fakeProvider(model = "fake:hash-1536"): EmbeddingProvider & { calls: number } {
  const provider = {
    model,
    calls: 0,
    async embed(values: string[]) {
      provider.calls++;
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

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
  vi.stubEnv("OPENAI_API_KEY", "");
});

const LEASE = "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit. ".repeat(30);
const PAYROLL = "Payroll runs on the fifteenth. Overtime is paid at one and a half times the hourly wage. ".repeat(30);

async function seedDocument(auth: { workspaceId: string; userId: string }, text: string, title: string) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: `${title}.pdf` }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "application/pdf" }).returning();
  extractor.extract.mockResolvedValueOnce({
    ok: true, text, spans: [{ page: 1, start: 0, end: text.length }], pageCount: 1, extractor: "fixture@1",
  });
  const result = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!result.ok) throw new Error("seed extraction failed");
  return { doc, extractionId: result.extractionId };
}

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `emb-${crypto.randomUUID()}`), role: "owner" as const });
const chunkRows = (extractionId: string) =>
  holder.db!.select().from(embeddings).where(eq(embeddings.ownerId, extractionId)).orderBy(embeddings.chunkIndex);

suite("embedding pass and chunk search (real Postgres + pgvector)", () => {
  it("writes chunk rows for a succeeded extraction with offsets and page", async () => {
    const auth = await workspace();
    const { extractionId } = await seedDocument(auth, LEASE, "lease");
    const provider = fakeProvider();
    expect(await embedExtraction(auth, { extractionId, provider })).toMatchObject({ status: "succeeded" });
    const rows = await chunkRows(extractionId);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]).toMatchObject({ ownerType: "document_extraction", chunkIndex: 0, page: 1, model: "fake:hash-1536" });
    for (const r of rows) expect(LEASE.slice(r.spanStart!, r.spanEnd!)).toBe(r.content);
    const [ex] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extractionId));
    expect(ex).toMatchObject({ status: "succeeded", embedModel: "fake:hash-1536", embedError: null });
    expect(ex.embeddedAt).not.toBeNull();
  });

  it("a second pass replaces the chunks and never doubles them", async () => {
    const auth = await workspace();
    const { extractionId } = await seedDocument(auth, LEASE, "lease");
    const provider = fakeProvider();
    await embedExtraction(auth, { extractionId, provider });
    const first = await chunkRows(extractionId);
    await embedExtraction(auth, { extractionId, provider });
    await Promise.all([embedExtraction(auth, { extractionId, provider }), embedExtraction(auth, { extractionId, provider })]);
    const after = await chunkRows(extractionId);
    expect(after).toHaveLength(first.length);
    expect(after.map((r) => r.chunkIndex)).toEqual(first.map((r) => r.chunkIndex));
  });

  it("a failed embed leaves the extraction succeeded, keeps the old chunks, and does not re-read the file", async () => {
    const auth = await workspace();
    const { extractionId } = await seedDocument(auth, LEASE, "lease");
    const good = fakeProvider();
    await embedExtraction(auth, { extractionId, provider: good });
    const before = await chunkRows(extractionId);
    const broken: EmbeddingProvider = { model: good.model, embed: async () => { throw new Error("quota exceeded sk-secret"); } };
    const readsBefore = extractor.extract.mock.calls.length;
    expect(await embedExtraction(auth, { extractionId, provider: broken })).toEqual({
      status: "failed", error: "Embedding could not complete. Retry to try again.",
    });
    const [ex] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extractionId));
    expect(ex.status).toBe("succeeded");
    expect(ex.embedError).toBe("Embedding could not complete. Retry to try again.");
    expect(ex.embedError).not.toContain("sk-secret");
    expect(await chunkRows(extractionId)).toHaveLength(before.length);
    expect(extractor.extract.mock.calls.length).toBe(readsBefore);
  });

  it("rejects vectors of the wrong width instead of writing them", async () => {
    const auth = await workspace();
    const { extractionId } = await seedDocument(auth, LEASE, "lease");
    const narrow: EmbeddingProvider = { model: "bad", embed: async (v) => v.map(() => [1, 2, 3]) };
    expect(await embedExtraction(auth, { extractionId, provider: narrow })).toMatchObject({ status: "failed" });
    expect(await chunkRows(extractionId)).toHaveLength(0);
  });

  it("only runs after text succeeded", async () => {
    const auth = await workspace();
    const { extractionId } = await seedDocument(auth, LEASE, "lease");
    await holder.db!.update(documentExtractions).set({ status: "failed" }).where(eq(documentExtractions.id, extractionId));
    const provider = fakeProvider();
    expect(await embedExtraction(auth, { extractionId, provider })).toEqual({ status: "skipped", reason: "not_succeeded" });
    expect(provider.calls).toBe(0);
  });

  it("with no provider configured, extraction still succeeds and the missing key is recorded", async () => {
    const auth = await workspace();
    const { extractionId } = await seedDocument(auth, LEASE, "lease");
    const [ex] = await holder.db!.select().from(documentExtractions).where(eq(documentExtractions.id, extractionId));
    expect(ex.status).toBe("succeeded");
    expect(ex.embedError).toContain("OPENAI_API_KEY");
    expect(await chunkRows(extractionId)).toHaveLength(0);
  });

  it("search returns the closest span, scoped to the workspace", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const lease = await seedDocument(mine, LEASE, "lease");
    const payroll = await seedDocument(mine, PAYROLL, "payroll");
    const foreign = await seedDocument(theirs, LEASE, "their lease");
    const provider = fakeProvider();
    for (const id of [lease.extractionId, payroll.extractionId, foreign.extractionId]) {
      const owner = id === foreign.extractionId ? theirs : mine;
      await embedExtraction(owner, { extractionId: id, provider });
    }

    const hits = await searchChunks(mine, { query: "monthly rent security deposit", provider, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ documentId: lease.doc.id, title: "lease", extractionId: lease.extractionId });
    expect(hits[0].text).toContain("rent");
    expect(LEASE.slice(hits[0].span.start, hits[0].span.end)).toBe(hits[0].text);
    expect(hits[0].span.page).toBe(1);
    expect(hits[0].distance).toBeLessThan(hits.at(-1)!.distance + 1e-9);
    // Nothing from the other workspace, even though its text is identical.
    expect(hits.every((h) => h.documentId !== foreign.doc.id)).toBe(true);
    const theirHits = await searchChunks(theirs, { query: "monthly rent security deposit", provider });
    expect(theirHits.every((h) => h.documentId === foreign.doc.id)).toBe(true);
  });

  it("search answers from the newest extraction and ignores chunks from another model", async () => {
    const auth = await workspace();
    const { doc, extractionId } = await seedDocument(auth, LEASE, "lease");
    const provider = fakeProvider();
    await embedExtraction(auth, { extractionId, provider });
    expect(await searchChunks(auth, { query: "rent", provider: fakeProvider("other-model") })).toEqual([]);

    // A newer succeeded extraction supersedes the old chunks in search.
    const [newer] = await holder.db!.insert(documentExtractions).values({
      workspaceId: auth.workspaceId, documentId: doc.id, contentHash: `v2-${crypto.randomUUID()}`,
      status: "succeeded", text: PAYROLL, spans: [{ page: 1, start: 0, end: PAYROLL.length }],
    }).returning();
    expect(await searchChunks(auth, { query: "monthly rent", provider })).toEqual([]);
    await embedExtraction(auth, { extractionId: newer.id, provider });
    const hits = await searchChunks(auth, { query: "overtime wage", provider });
    expect(hits[0].extractionId).toBe(newer.id);
    // Old chunks stay stored for the old version.
    const old = await holder.db!.select({ n: sql<number>`count(*)::int` }).from(embeddings)
      .where(and(eq(embeddings.ownerId, extractionId)));
    expect(old[0].n).toBeGreaterThan(0);
  });

  it("an empty query returns nothing without calling the provider", async () => {
    const auth = await workspace();
    const provider = fakeProvider();
    expect(await searchChunks(auth, { query: "   ", provider })).toEqual([]);
    expect(provider.calls).toBe(0);
  });
});
