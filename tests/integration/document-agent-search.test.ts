import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, embeddings, files } from "@/domains/knowledge/schema";
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
import { searchDocumentsForAgent } from "@/domains/knowledge/agent-search";
import { ensureProfile } from "@/domains/agents/commands";
import { agentProfiles, agentRuns, toolCalls } from "@/domains/agents/schema";
import { listDocumentSearchResults } from "@/domains/agents/queries";
import { actionProposals } from "@/domains/actions/schema";
import { extractDocument } from "@/domains/knowledge/extraction";

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

suite("documents.search for the agent (real Postgres + pgvector)", () => {
  it("returns document id, title, passage and span for the caller's workspace only", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const b = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    await seed(a, PAYROLL, "payroll", provider);
    await seed(b, LEASE, "other tenant lease", provider);
    const res = await searchDocumentsForAgent({ ...a, role: "viewer" }, { query: "monthly rent security deposit", limit: 3, provider });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results[0]).toMatchObject({ documentId: lease.id, title: "lease", span: { page: 1 } });
    expect(LEASE.slice(res.results[0].span.start, res.results[0].span.end).startsWith(res.results[0].text.slice(0, 20))).toBe(true);
    expect(res.results.map((r) => r.title)).not.toContain("other tenant lease");
    const bRes = await searchDocumentsForAgent({ ...b, role: "viewer" }, { query: "rent", provider });
    expect(bRes.ok && bRes.results.every((r) => r.title === "other tenant lease")).toBe(true);
  });

  it("caps the limit and passage length, and rejects an empty query", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, LEASE, "lease", provider);
    const res = await searchDocumentsForAgent(a, { query: "rent", limit: 500, provider });
    expect(res.ok && res.results.length <= 10 && res.results.every((r) => r.text.length <= 1201)).toBe(true);
    expect(await searchDocumentsForAgent(a, { query: "   ", provider })).toEqual({ ok: false, error: "query is empty" });
  });

  it("writes nothing: no proposals, documents or chunks change", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, LEASE, "lease", provider);
    const count = async () => [
      (await holder.db!.select().from(actionProposals)).length,
      (await holder.db!.select().from(documents).where(eq(documents.workspaceId, a.workspaceId))).length,
      (await holder.db!.select().from(embeddings).where(eq(embeddings.workspaceId, a.workspaceId))).length,
    ];
    const before = await count();
    await searchDocumentsForAgent(a, { query: "rent", provider });
    expect(await count()).toEqual(before);
  });

  it("gives fixed messages for a missing key and for provider failures, never provider text", async () => {
    const a = await workspace();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(await searchDocumentsForAgent(a, { query: "rent" })).toEqual({ ok: false, error: "document search is not configured (no embedding key)" });
    const broken: EmbeddingProvider = { model: "m", embed: async () => { throw new Error("401 sk-live-secret"); } };
    const res = await searchDocumentsForAgent(a, { query: "rent", provider: broken });
    expect(res).toEqual({ ok: false, error: "document search failed, try again" });
  });

  it("the default profile grants the read and internal tools, and an older profile gains only those", async () => {
    const a = await workspace();
    await ensureProfile(a.workspaceId);
    const [p] = await holder.db!.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, a.workspaceId));
    // A closed list on purpose: a capability the profile does not grant is
    // denied on every call, so any addition here is a deliberate widening and
    // deserves this diff.
    expect(p.allowedTools).toEqual([
      "tasks.read",
      "documents.search",
      "wiki.read",
      "wiki.ingest",
      "wiki.lint",
      "gmail.send",
      "gmail.read",
      "gmail.thread.read",
      "github.read",
      "github.issue.read",
      "slack.channels.read",
      "slack.read",
      "calendar.read",
      "notion.read",
      "notebook.open",
      "learning.review",
    ]);
    const b = await workspace();
    await ensureProfile(b.workspaceId);
    await holder.db!.update(agentProfiles).set({ allowedTools: ["tasks.read"] }).where(eq(agentProfiles.workspaceId, b.workspaceId));
    await ensureProfile(b.workspaceId);
    await ensureProfile(b.workspaceId);
    const [old] = await holder.db!.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, b.workspaceId));
    expect(old.allowedTools).toEqual([
      "tasks.read",
      "documents.search",
      "wiki.read",
      "wiki.ingest",
      "wiki.lint",
      "gmail.read",
      "gmail.thread.read",
      "github.read",
      "github.issue.read",
      "slack.channels.read",
      "slack.read",
      "calendar.read",
      "notion.read",
      "notebook.open",
      "learning.review",
    ]);
  });

  it("recorded search results come back per run, inside the workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    const profileId = await ensureProfile(a.workspaceId);
    const [run] = await holder.db!.insert(agentRuns).values({
      workspaceId: a.workspaceId, agentProfileId: profileId, objective: "find rent", state: "running", policySnapshot: {},
    } as typeof agentRuns.$inferInsert).returning();
    await holder.db!.insert(toolCalls).values([
      { workspaceId: a.workspaceId, runId: run.id, toolName: "documents_search", ok: true, result: { ok: true, results: [{ documentId: "d", title: "T", text: "x", span: { start: 0, end: 1, page: 1 } }] } },
      { workspaceId: a.workspaceId, runId: run.id, toolName: "tasks_read", ok: true, result: { ok: true } },
      { workspaceId: a.workspaceId, runId: run.id, toolName: "documents_search", ok: false, result: null },
    ]);
    expect((await listDocumentSearchResults(a.workspaceId, [run.id])).get(run.id)).toHaveLength(1);
    expect((await listDocumentSearchResults(b.workspaceId, [run.id])).get(run.id)).toBeUndefined();
  });
});
