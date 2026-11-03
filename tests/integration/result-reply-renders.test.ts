import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The result-reply lane renders in a reloaded conversation.
 *
 * Value card
 * protects: the person's visibility into what the machinery did for them —
 *   a superagent cutover writes the specialist's answer to the sessionless
 *   conversation run as a `message.completed` event, and the conversation
 *   page must show that answer when the run is reloaded, not just the
 *   person's own words plus "This run has no agent session."
 * fails_when: the stored thread reader (listThreads/toEntry) maps only the
 *   `message` event kind, so the reply lane's `message.completed` event
 *   falls to the audit-only bucket and the one answer the machinery
 *   produced never renders (the sweep-2 finding, reproduced live on the
 *   qa-tip build at head 77607441).
 * why_new: the reply lane shipped with a recordRoundEvent call only; no
 *   test read the event back through the same reader the page renders.
 * seam: listThreads over real Postgres rows shaped exactly as the reply
 *   lane writes them (wiring.ts chatReplySender's recordRoundEvent payload).
 * no_claim: the live-stream path (frameOf in stream-contract.ts owns that
 *   fold), the assessor's decision behaviour (the superagent specs own it),
 *   and the placeholder frame for runs whose session genuinely failed
 *   (chat-stream-route.test.ts pins that contract).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { listThreads } from "@/domains/agents/thread";

let ws: { userId: string; workspaceId: string };
let profileId: string;

beforeAll(async () => {
  holder.db = handle?.db;
  ws = await seedWorkspace(handle!.db, "result-reply");
  const [profile] = await handle!.db
    .insert(agentProfiles)
    .values({ workspaceId: ws.workspaceId, name: "polymath" })
    .returning({ id: agentProfiles.id });
  profileId = profile.id;
});

afterAll(async () => {
  await handle?.client.end();
});

/** A finished conversation run as the superagent intake creates it: no session, ever. */
async function insertConversationRun(objective: string) {
  const [run] = await handle!.db
    .insert(agentRuns)
    .values({
      workspaceId: ws.workspaceId,
      agentProfileId: profileId,
      objective,
      state: "waiting_input",
      policySnapshot: {},
      sessionRef: null,
    })
    .returning({ id: agentRuns.id });
  return run.id;
}

/** One event, in the reply lane's own write shape (recordRoundEvent). */
function insertEvent(runId: string, sequence: number, type: string, data: unknown) {
  return handle!.db
    .insert(runEvents)
    .values({ workspaceId: ws.workspaceId, runId, sequence, type, data: data as never });
}

suite("listThreads renders the result reply", () => {
  it("turns the reply lane's message.completed event into an assistant entry", async () => {
    const runId = await insertConversationRun("Please look at my Q4 planning");
    await insertEvent(runId, 1, "message", { role: "user", content: "Please look at my Q4 planning" });
    // Exactly the payload chatReplySender records: the machinery turn id, the
    // answer text under `message`, no finish reason.
    await insertEvent(runId, 2, "message.completed", {
      turnId: "superagent:4cadd2a7dbfc5767cf4822e533b2cec6",
      stepIndex: 0,
      message: "Nothing in your workspace documents covers Q4 planning yet.",
      finishReason: null,
    });

    const entries = (await listThreads(ws.workspaceId, [runId])).get(runId) ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "user", text: "Please look at my Q4 planning" });
    expect(entries[1]).toMatchObject({
      kind: "assistant",
      text: "Nothing in your workspace documents covers Q4 planning yet.",
      turnId: "superagent:4cadd2a7dbfc5767cf4822e533b2cec6",
    });
  });

  it("keeps an empty message.completed out of the thread", async () => {
    const runId = await insertConversationRun("A reply that carried no text");
    await insertEvent(runId, 1, "message.completed", {
      turnId: "superagent:empty",
      stepIndex: 0,
      message: "",
      finishReason: "stop",
    });
    const entries = (await listThreads(ws.workspaceId, [runId])).get(runId) ?? [];
    expect(entries).toHaveLength(0);
  });
});
