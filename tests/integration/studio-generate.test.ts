import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";
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
import { saveGeneratedDraft, saveDraft, discardDraft, startStudioGenerate, StudioError } from "@/domains/knowledge/studio";
import { artifactLinks, artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { attachDocuments } from "@/domains/knowledge/projects";
import { recordRoundEvent } from "@/domains/agents/event-bridge";
import { createProject } from "@/domains/knowledge/projects";
import { ensureProfile } from "@/domains/agents/commands";
import { agentRuns } from "@/domains/agents/schema";
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



async function runFor(a: { userId: string; workspaceId: string }, projectId: string, reply?: string) {
  const profileId = await ensureProfile(a.workspaceId);
  const [run] = await holder.db!.insert(agentRuns).values({
    workspaceId: a.workspaceId, agentProfileId: profileId, objective: "Draft", state: "succeeded", policySnapshot: {},
    subjects: [{ type: "project", id: projectId }],
  } as typeof agentRuns.$inferInsert).returning();
  if (reply) await recordRoundEvent({ runId: run.id, workspaceId: a.workspaceId, type: "message", data: { role: "assistant", content: reply } });
  return run;
}

suite("Studio Generate (real Postgres)", () => {
  it("starts a bound run whose objective names the dossier", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    const d = await createProject(a, { name: "Housing", documentIds: [lease.id] });
    const engine = { start: vi.fn(async () => ({ runId: "r", reservationId: "x" })) } as never as import("@/domains/agents/engine").AgentEngine;
    await startStudioGenerate(a, { projectId: d.id, brief: "a summary of the rent terms" }, engine);
    expect((engine.start as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      subjects: [{ type: "project", id: d.id }],
      objective: expect.stringContaining('"Housing"'),
    });
    const b = await workspace();
    await expect(startStudioGenerate(b, { projectId: d.id, brief: "x" }, engine)).rejects.toMatchObject({ code: "dossier_not_found" });
  });

  it("pins a queued URL capture (no file yet) by address, in the objective and in the saved links", async () => {
    const a = await workspace();
    const d = await createProject(a, { name: "Research", documentIds: [] });
    // A queued capture: a document with a sourceUrl and no fileId, the shape a
    // pasted link has before its bytes land.
    const [queued] = await holder.db!.insert(documents).values({
      workspaceId: a.workspaceId,
      title: "Queued page",
      sourceUrl: `https://example.com/queued-${crypto.randomUUID()}`,
      createdBy: a.userId,
      updatedBy: a.userId,
    }).returning();
    await attachDocuments(a, { projectId: d.id, documentIds: [queued!.id] });

    const engine = { start: vi.fn(async () => ({ runId: "r", reservationId: "x" })) } as never as import("@/domains/agents/engine").AgentEngine;
    await startStudioGenerate(a, { projectId: d.id, brief: "summarize the page" }, engine);
    // The objective names the queued document: the address join found it.
    expect((engine.start as ReturnType<typeof vi.fn>).mock.calls[0][0].objective).toContain(queued!.id);

    const { artifactId } = await saveGeneratedDraft(a, { runId: (await runFor(a, d.id, "The page says hi.")).id });
    const links = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.artifactId, artifactId));
    expect(links.some((l) => l.targetType === "document" && l.targetId === queued!.id)).toBe(true);
  });

  it("saves the output as a draft artifact linked to the pinned document versions, once", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    const d = await createProject(a, { name: "Housing", documentIds: [lease.id] });
    const run = await runFor(a, d.id, "Rent is $1,200 a month.");
    const { artifactId, created } = await saveGeneratedDraft(a, { runId: run.id });
    expect(created).toBe(true);
    const [art] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, artifactId));
    expect(art).toMatchObject({ status: "draft", kind: "report", producedByRunId: run.id });
    const [v] = await holder.db!.select().from(artifactVersions).where(eq(artifactVersions.artifactId, artifactId));
    expect(v).toMatchObject({ versionNumber: 1, reason: "generated", plainText: "Rent is $1,200 a month." });
    expect(art.currentVersionId).toBe(v.id);
    const links = await holder.db!.select().from(artifactLinks).where(eq(artifactLinks.artifactId, artifactId));
    const docLink = links.find((l) => l.targetType === "document")!;
    expect(docLink.targetId).toBe(lease.id);
    expect(docLink.label).toMatch(/^pinned:[0-9a-f]{8,}/);
    expect(links.some((l) => l.targetType === "run" && l.targetId === run.id)).toBe(true);
    expect(await saveGeneratedDraft(a, { runId: run.id })).toEqual({ artifactId, created: false });
  });

  it("refuses a run with no output or in another workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    const d = await createProject(a, { name: "D", documentIds: [] });
    const quiet = await runFor(a, d.id);
    await expect(saveGeneratedDraft(a, { runId: quiet.id })).rejects.toMatchObject({ code: "no_output" });
    const loud = await runFor(a, d.id, "text");
    await expect(saveGeneratedDraft(b, { runId: loud.id })).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("owner saves (reviewed, never published) or discards, once", async () => {
    const a = await workspace();
    const d = await createProject(a, { name: "D", documentIds: [] });
    const keep = await saveGeneratedDraft(a, { runId: (await runFor(a, d.id, "keep me")).id });
    await saveDraft(a, { artifactId: keep.artifactId });
    const [kept] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, keep.artifactId));
    expect(kept.status).toBe("reviewed");
    expect(kept.status).not.toBe("published");
    await expect(discardDraft(a, { artifactId: keep.artifactId })).rejects.toBeInstanceOf(StudioError);

    const drop = await saveGeneratedDraft(a, { runId: (await runFor(a, d.id, "drop me")).id });
    await discardDraft(a, { artifactId: drop.artifactId });
    const [dropped] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, drop.artifactId));
    expect(dropped.status).toBe("archived");
    expect(dropped.archivedAt).not.toBeNull();
    await expect(saveDraft(a, { artifactId: drop.artifactId })).rejects.toMatchObject({ code: "not_a_draft" });
    const b = await workspace();
    const other = await saveGeneratedDraft(a, { runId: (await runFor(a, d.id, "x")).id });
    await expect(saveDraft(b, { artifactId: other.artifactId })).rejects.toMatchObject({ code: "not_a_draft" });
  });

  it("a generated-status draft is not decidable: save and discard both refuse and change nothing", async () => {
    const a = await workspace();
    const d = await createProject(a, { name: "D", documentIds: [] });
    const { artifactId } = await saveGeneratedDraft(a, { runId: (await runFor(a, d.id, "still generating")).id });
    // A run that has been picked up but not finished moves its artifact to
    // "generated" — the in-between state the UI renders as a spinner. Only a
    // "draft" can be decided.
    await holder.db!.update(artifacts).set({ status: "generated" }).where(eq(artifacts.id, artifactId));
    const before = await holder.db!.select().from(artifacts).where(eq(artifacts.id, artifactId));

    await expect(saveDraft(a, { artifactId })).rejects.toMatchObject({ code: "not_a_draft" });
    await expect(discardDraft(a, { artifactId })).rejects.toMatchObject({ code: "not_a_draft" });

    const [after] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, artifactId));
    expect(after).toMatchObject({ status: "generated", version: before[0]!.version, archivedAt: before[0]!.archivedAt });
  });
});
