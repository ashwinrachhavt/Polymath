import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import type { AgentEngine } from "@/domains/agents/engine";
import { artifactLinks, artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { applyNoteAIResult, getNoteAIRunOutput, listNoteAIRuns, startNoteAIRun } from "@/domains/knowledge/note-ai";

/** Records the engine.start input instead of driving a session. */
function stubEngine() {
  const calls: Parameters<AgentEngine["start"]>[0][] = [];
  const engine: AgentEngine = {
    start: async (input) => {
      calls.push(input);
      return { runId: crypto.randomUUID(), reservationId: crypto.randomUUID() };
    },
    signal: async () => {},
    resume: async () => {},
    cancel: async () => ({ cancelled: true }),
  };
  return { engine, calls };
}

suite("notebook AI (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let noteId: string;
  let otherNoteId: string;
  let runId: string;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `note-ai-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);

    const make = async (title: string, text: string) => {
      const [artifact] = await handle.db
        .insert(artifacts)
        .values({ workspaceId: seed.workspaceId, kind: "note", title, createdBy: seed.userId, updatedBy: seed.userId })
        .returning();
      const [version] = await handle.db
        .insert(artifactVersions)
        .values({ workspaceId: seed.workspaceId, artifactId: artifact.id, versionNumber: 1, content: { format: "markdown", text }, plainText: text, reason: "created", createdBy: seed.userId })
        .returning();
      await handle.db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
      return artifact.id;
    };
    noteId = await make("Launch checklist", "Draft the announcement. Line up the beta list.");
    otherNoteId = await make("Other note", "Unrelated.");

    const [profile] = await handle.db
      .insert(agentProfiles)
      .values({ workspaceId: seed.workspaceId, name: "polymath", createdBy: seed.userId, updatedBy: seed.userId })
      .returning();
    const [run] = await handle.db
      .insert(agentRuns)
      .values({
        workspaceId: seed.workspaceId,
        agentProfileId: profile.id,
        objective: "Notebook AI: improve the writing…",
        subjects: [{ type: "note", id: noteId }],
        policySnapshot: {},
        state: "succeeded",
        createdBy: seed.userId,
        updatedBy: seed.userId,
      })
      .returning();
    await handle.db.insert(runEvents).values({
      workspaceId: seed.workspaceId,
      runId: run.id,
      sequence: 1,
      type: "message",
      data: { role: "assistant", content: "Polished: Draft the announcement and line up the beta list." },
    });
    runId = run.id;
  });

  it("startNoteAIRun composes the objective from the note and binds the subject", async () => {
    if (!handle) return;
    const { engine, calls } = stubEngine();
    await startNoteAIRun(auth, { artifactId: noteId, action: "improve" }, engine);
    expect(calls).toHaveLength(1);
    expect(calls[0].profileName).toBe("polymath");
    expect(calls[0].subjects).toEqual([{ type: "note", id: noteId }]);
    expect(calls[0].objective).toContain('"Launch checklist"');
    expect(calls[0].objective).toContain("Draft the announcement.");
  });

  it("startNoteAIRun validates action inputs before spending anything", async () => {
    if (!handle) return;
    const { engine, calls } = stubEngine();
    await expect(startNoteAIRun(auth, { artifactId: noteId, action: "ask" }, engine)).rejects.toThrow("needs a question");
    await expect(startNoteAIRun(auth, { artifactId: noteId, action: "translate" }, engine)).rejects.toThrow("needs a target language");
    await expect(startNoteAIRun(auth, { artifactId: crypto.randomUUID(), action: "improve" }, engine)).rejects.toThrow("No such note");
    expect(calls).toHaveLength(0);
  });

  it("listNoteAIRuns returns only Notebook AI runs bound to the note", async () => {
    if (!handle) return;
    const runs = await listNoteAIRuns(auth, noteId);
    expect(runs).toHaveLength(1);
    expect(runs[0].objective).toMatch(/^Notebook AI/);
    expect(await listNoteAIRuns(auth, otherNoteId)).toHaveLength(0);
  });

  it("getNoteAIRunOutput returns the latest assistant message", async () => {
    if (!handle) return;
    const out = await getNoteAIRunOutput(auth, runId);
    expect(out.state).toBe("succeeded");
    expect(out.output).toContain("Polished:");
  });

  it("applyNoteAIResult commits a version under the guard and records run lineage", async () => {
    if (!handle) return;
    const [artifact] = await handle.db.select({ version: artifacts.version }).from(artifacts).where(eq(artifacts.id, noteId));
    const applied = "Draft the announcement and line up the beta list.";
    const result = await applyNoteAIResult(auth, {
      artifactId: noteId,
      runId,
      expectedVersion: artifact.version,
      content: { format: "markdown", text: applied },
      plainText: applied,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.version).toBe(artifact.version + 1);
    const [link] = await handle.db
      .select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, noteId), eq(artifactLinks.targetType, "run"), eq(artifactLinks.targetId, runId)));
    expect(link.label).toBe("ai draft applied");
    // A run started from another note cannot leave lineage on this one.
    await expect(
      applyNoteAIResult(auth, { artifactId: otherNoteId, runId, expectedVersion: 1, content: { format: "markdown", text: "x" }, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow("not started from this note");
  });
});
