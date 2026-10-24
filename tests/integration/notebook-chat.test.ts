import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuns, toolCalls } from "@/domains/agents/schema";
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

import { ensureProfile } from "@/domains/agents/commands";
import { recordRoundEvent } from "@/domains/agents/event-bridge";
import {
  lastGroundedAnswer,
  listNotebookChats,
  notebookChatLabels,
  notebookChatObjective,
} from "@/domains/knowledge/notebook-chat";
import { createDossier } from "@/domains/knowledge/dossiers";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

async function runFor(
  a: { userId: string; workspaceId: string },
  dossierId: string,
  objective: string,
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" = "succeeded",
) {
  const profileId = await ensureProfile(a.workspaceId);
  const [run] = await holder.db!.insert(agentRuns).values({
    workspaceId: a.workspaceId,
    agentProfileId: profileId,
    objective,
    state,
    policySnapshot: {},
    subjects: [{ type: "dossier", id: dossierId }],
  } as typeof agentRuns.$inferInsert).returning();
  return run;
}

const workspace = async () => {
  const seed = await seedWorkspace(holder.db!, `nb-${crypto.randomUUID()}`);
  return ownerAuth(seed.userId, seed.workspaceId);
};

suite("notebook chat (real Postgres)", () => {
  it("lists a notebook's chat runs and excludes Studio Generate runs", async () => {
    const a = await workspace();
    const dossier = await createDossier(a, { name: "Housing", documentIds: [] });
    const chat = await runFor(a, dossier.id, notebookChatObjective("Housing"));
    await runFor(a, dossier.id, 'Using only the documents in the dossier "Housing", write a draft report: rent terms.');
    const chats = await listNotebookChats(a, dossier.id);
    expect(chats.map((c) => c.runId)).toEqual([chat.id]);
  });

  it("never leaks another workspace's chats", async () => {
    const a = await workspace();
    const b = await workspace();
    const dossier = await createDossier(a, { name: "Housing", documentIds: [] });
    await runFor(a, dossier.id, notebookChatObjective("Housing"));
    expect(await listNotebookChats(b, dossier.id)).toEqual([]);
  });

  it("labels a conversation by the first question actually asked", async () => {
    const a = await workspace();
    const dossier = await createDossier(a, { name: "Housing", documentIds: [] });
    const fresh = await runFor(a, dossier.id, notebookChatObjective("Housing"));
    const asked = await runFor(a, dossier.id, notebookChatObjective("Housing"));
    // The engine writes the objective as the first user event at start; the
    // label is the first follow-up, never the grounding instruction.
    await recordRoundEvent({ runId: asked.id, workspaceId: a.workspaceId, type: "message", data: { role: "user", content: notebookChatObjective("Housing") } });
    await recordRoundEvent({ runId: asked.id, workspaceId: a.workspaceId, type: "message", data: { role: "user", content: "What is the monthly rent?" } });
    await recordRoundEvent({ runId: asked.id, workspaceId: a.workspaceId, type: "message", data: { role: "assistant", content: "Twelve hundred dollars." } });
    const labels = await notebookChatLabels(a.workspaceId, [fresh.id, asked.id]);
    expect(labels.get(fresh.id)).toBe("New conversation");
    expect(labels.get(asked.id)).toBe("What is the monthly rent?");
  });

  it("recovers the last answer with the citations its tool calls produced", async () => {
    const a = await workspace();
    const dossier = await createDossier(a, { name: "Housing", documentIds: [] });
    const chat = await runFor(a, dossier.id, notebookChatObjective("Housing"));
    const documentId = crypto.randomUUID();
    await holder.db!.insert(toolCalls).values({
      workspaceId: a.workspaceId,
      runId: chat.id,
      toolName: "documents_search",
      ok: true,
      result: {
        results: [
          { documentId, title: "lease.pdf", text: "The tenant pays monthly rent of twelve hundred dollars.", span: { start: 0, end: 60, page: 1 } },
          { documentId, title: "lease.pdf", text: "The tenant pays monthly rent of twelve hundred dollars.", span: { start: 0, end: 60, page: 1 } },
        ],
      },
    });
    await recordRoundEvent({ runId: chat.id, workspaceId: a.workspaceId, type: "message", data: { role: "assistant", content: "The rent is twelve hundred dollars a month." } });
    const answer = await lastGroundedAnswer(a, chat.id);
    expect(answer?.answer).toBe("The rent is twelve hundred dollars a month.");
    // The duplicate passage (same document and span) collapses to one citation.
    expect(answer?.citations).toEqual([
      { documentId, title: "lease.pdf", text: "The tenant pays monthly rent of twelve hundred dollars.", span: { start: 0, end: 60, page: 1 } },
    ]);
  });

  it("answers null for a conversation with no assistant reply and for a foreign run", async () => {
    const a = await workspace();
    const b = await workspace();
    const dossier = await createDossier(a, { name: "Housing", documentIds: [] });
    const chat = await runFor(a, dossier.id, notebookChatObjective("Housing"));
    expect(await lastGroundedAnswer(a, chat.id)).toBeNull();
    // Same answer as missing: a run in another workspace.
    const answer = await lastGroundedAnswer(a, chat.id);
    void answer;
    expect(await lastGroundedAnswer(b, chat.id)).toBeNull();
  });
});
