import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, files, sources } from "@/domains/knowledge/schema";
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
import { ProjectError, attachDocuments, createProject, projectDocumentIds, listProjects } from "@/domains/knowledge/projects";
import { notebookSources } from "@/domains/knowledge/schema";
import { searchDocumentsForAgent } from "@/domains/knowledge/agent-search";
import { extractDocument } from "@/domains/knowledge/extraction";
import { queueYouTubeCapture } from "@/domains/knowledge/youtube-capture";
import { recordSource } from "@/domains/knowledge/sources";

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

async function seed(auth: { workspaceId: string; userId: string }, text: string, title: string, provider: EmbeddingProvider) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: `${title}.pdf` }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "application/pdf" }).returning();
  extractor.extract.mockResolvedValueOnce({ ok: true, text, spans: [{ page: 1, start: 0, end: text.length }], pageCount: 1, extractor: "fixture@1" });
  const result = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!result.ok) throw new Error("seed failed");
  await embedExtraction({ ...auth, role: "owner" as const }, { extractionId: result.extractionId, provider });
  return doc;
}
const workspace = async () => ({ ...await seedWorkspace(holder.db!, `ds-${crypto.randomUUID()}`), role: "owner" as const });


suite("projects (real Postgres + pgvector)", () => {
  it("creates a project from a name and document ids, pinning each document's text version", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    const pay = await seed(a, PAYROLL, "payroll", provider);
    const d = await createProject(a, { name: "  Housing  ", documentIds: [lease.id, pay.id, lease.id] });
    expect(d.title).toBe("Housing");
    const rows = await holder.db!.select().from(notebookSources).where(eq(notebookSources.notebookId, d.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => typeof r.pinnedContentHash === "string" && r.pinnedContentHash.length > 0)).toBe(true);
    expect((await projectDocumentIds(a, d.id))!.sort()).toEqual([lease.id, pay.id].sort());
    expect((await listProjects(a)).find((x) => x.id === d.id)).toMatchObject({ title: "Housing", documentCount: 2 });
  });

  it("attaching a foreign document fails and writes nothing, including on create", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const b = await workspace();
    const mine = await seed(a, LEASE, "mine", provider);
    const theirs = await seed(b, LEASE, "theirs", provider);
    await expect(createProject(a, { name: "Mixed", documentIds: [mine.id, theirs.id] })).rejects.toMatchObject({ code: "documents_not_found" });
    expect((await listProjects(a)).some((x) => x.title === "Mixed")).toBe(false);
    const ok = await createProject(a, { name: "Mine", documentIds: [mine.id] });
    await expect(attachDocuments(a, { projectId: ok.id, documentIds: [theirs.id] })).rejects.toBeInstanceOf(ProjectError);
    expect(await projectDocumentIds(a, ok.id)).toEqual([mine.id]);
    await expect(attachDocuments(b, { projectId: ok.id, documentIds: [theirs.id] })).rejects.toMatchObject({ code: "project_not_found" });
    expect(await projectDocumentIds(b, ok.id)).toBeNull();
  });

  it("attach is idempotent and rejects a blank name", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    const d = await createProject(a, { name: "D", documentIds: [lease.id] });
    expect(await attachDocuments(a, { projectId: d.id, documentIds: [lease.id] })).toEqual({ attached: 0 });
    await expect(createProject(a, { name: "   ", documentIds: [] })).rejects.toMatchObject({ code: "invalid_name" });
  });

  it("a queued capture binds by address through the real writer path, and landing keeps one source", async () => {
    const a = await workspace();
    // The real queued-capture shape: queueYouTubeCapture writes a documents row
    // with a canonical sourceUrl and no fileId, and enqueues the transcript
    // job. No sources row exists until the handler or a notebook attach makes one.
    const videoId = crypto.randomUUID().replace(/-/g, "").slice(0, 11);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const queued = await queueYouTubeCapture(a, { url });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const [doc] = await holder.db!.select().from(documents).where(eq(documents.id, queued.documentId));
    expect(doc.sourceUrl).toBe(url);
    expect(doc.fileId).toBeNull();

    // Attaching the queued video makes the notebook's placeholder source row,
    // bound by address (sourceFor inserts with the url).
    const d = await createProject(a, { name: "Videos", documentIds: [queued.documentId] });
    expect(await projectDocumentIds(a, d.id)).toEqual([queued.documentId]);
    const beforeRows = await holder.db!.select().from(sources)
      .where(and(eq(sources.url, doc.sourceUrl!), eq(sources.workspaceId, a.workspaceId)));
    expect(beforeRows).toHaveLength(1);

    // The transcript lands: intakeFile attaches the file to the same document
    // and recordSource updates the url-matched placeholder in place - one row,
    // still the only one for this address, and the binding still resolves.
    const [blob] = await holder.db!.insert(blobObjects).values({
      workspaceId: a.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
      sizeBytes: 4, mimeType: "text/plain",
    }).returning();
    const [file] = await holder.db!.insert(files).values({ workspaceId: a.workspaceId, blobId: blob.id, filename: "video.txt" }).returning();
    await holder.db!.update(documents).set({ fileId: file.id }).where(eq(documents.id, queued.documentId));
    await recordSource(a, holder.db as never, { title: "The talk", url: doc.sourceUrl!, contentHash: "hash-1", kind: "document" });

    const afterRows = await holder.db!.select().from(sources)
      .where(and(eq(sources.url, doc.sourceUrl!), eq(sources.workspaceId, a.workspaceId)));
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].contentHash).toBe("hash-1");
    expect(await projectDocumentIds(a, d.id)).toEqual([queued.documentId]);
  });

  it("documents.search with a projectId only returns that project's documents", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    await seed(a, PAYROLL, "payroll", provider);
    const d = await createProject(a, { name: "Lease only", documentIds: [lease.id] });
    const scoped = await searchDocumentsForAgent(a, { query: "payroll overtime wage", projectId: d.id, limit: 10, provider });
    expect(scoped.ok && scoped.results.length > 0 && scoped.results.every((r) => r.documentId === lease.id)).toBe(true);
    const open = await searchDocumentsForAgent(a, { query: "payroll overtime wage", limit: 1, provider });
    expect(open.ok && open.results[0].title).toBe("payroll");
  });

  it("an empty project returns nothing, and an unknown or foreign project is an error", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const b = await workspace();
    await seed(a, LEASE, "lease", provider);
    const empty = await createProject(a, { name: "Empty", documentIds: [] });
    expect(await searchDocumentsForAgent(a, { query: "rent", projectId: empty.id, provider })).toEqual({ ok: true, query: "rent", mode: "semantic", results: [] });
    expect(await searchDocumentsForAgent(b, { query: "rent", projectId: empty.id, provider })).toEqual({ ok: false, error: "project not found" });
    expect(await searchDocumentsForAgent(a, { query: "rent", projectId: crypto.randomUUID(), provider })).toEqual({ ok: false, error: "project not found" });
  });
});
