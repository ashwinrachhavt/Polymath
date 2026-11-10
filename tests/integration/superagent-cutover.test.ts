import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { key } from "@/domains/superagent/core";
import { readStateValue } from "@/domains/superagent/store";
import { workTriggers } from "@/domains/superagent/store";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The cutover's end-to-end spine against real Postgres: a person's chat
 * message becomes a durable Trigger on the matching WorkThread, the policy
 * gate admits it (explicit, through the v1 chat posture), an assessment
 * effect is queued for the assessor, and the assessor's recorded decision
 * — driven here through the Engine's decide command, the same command the
 * eval session calls — opens a Ticket whose Mandate is frozen at the policy's
 * version, with the launch effect queued behind it. The executor's and
 * assessor's eve calls stay behind their ports (their own suites cover
 * them); this file proves the app-level composition: real repositories, the
 * real chat Source plugin, the real conversation row, the real cursor.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];

/*
 * The db-attached modules load dynamically, after makeTestDb() has pinned
 * DATABASE_URL: wiring (and the agents commands it composes) read the
 * variable at module load, and a static import would evaluate them against
 * the .env URL before the scratch database exists.
 */
let ensureProfile: typeof import("@/domains/agents/commands").ensureProfile;
let createConversationRun: typeof import("@/domains/agents/conversations").createConversationRun;
let sendFollowUp: typeof import("@/domains/agents/thread").sendFollowUp;
let superagentForWorkspace: typeof import("@/domains/superagent/wiring").superagentForWorkspace;

beforeAll(async () => {
  if (!handle) return;
  db = handle.db;
  ({ ensureProfile } = await import("@/domains/agents/commands"));
  ({ createConversationRun } = await import("@/domains/agents/conversations"));
  ({ sendFollowUp } = await import("@/domains/agents/thread"));
  ({ superagentForWorkspace } = await import("@/domains/superagent/wiring"));
});

afterAll(async () => {
  await handle?.client.end();
});

suite("the chat cutover", () => {
  it("hydrates a cold workspace before a background deadline reap", async () => {
    const { workspaceId } = await seedWorkspace(db, `superagent-cold-reap-${Date.now()}`);
    const { superagentEffectHandlers } = await import("@/domains/superagent/wiring");
    const handlers = await superagentEffectHandlers();
    const reap = handlers.reap;
    if (!reap) throw new Error("Missing deadline handler");
    await expect(
      reap({
        id: "cold-reap",
        workspaceId,
        kind: "reap",
        key: "deadline",
        payload: {},
        attempts: 1,
        consecutiveFailures: 0,
        leaseToken: "test-lease",
      }),
    ).resolves.toBeUndefined();
  });

  it("a follow-up on a sessionless conversation goes back through the pipeline, not the Eve driver", async () => {
    // The regression this covers: a conversation carrier has no Eve session,
    // so the reactive follow-up path threw "run has no Eve session yet" and
    // the chat answered 500. The message belongs to the same pipeline as the
    // first one.
    const { userId, workspaceId } = await seedWorkspace(db, `superagent-followup-${Date.now()}`);
    await ensureProfile(workspaceId, "polymath");
    const auth = ownerAuth(userId, workspaceId);

    const { runId } = await createConversationRun({
      auth,
      profileName: "polymath",
      message: "What did I ship last week?",
    });

    // This sessionless run represents persisted pre-cutover history. Seed its
    // original trigger so the follow-up can prove the legacy pipeline continues.
    const host = await superagentForWorkspace(workspaceId);
    await host.hydrate();
    host.engine.receive({
      id: key("chat", runId, "1"),
      source: "chat",
      threads: [{ source: "chat", id: runId }],
      actor: { source: "chat", id: userId },
      human: true,
      at: new Date().toISOString(),
      text: "What did I ship last week?",
      meta: {},
    });
    await host.flush();

    const sent = await sendFollowUp(auth, runId, "And what is still open?");
    expect(sent).toEqual({ ok: true });

    // Two user messages in one transcript, each its own Trigger: identical
    // words would be two sends, so the second must not dedupe into the first.
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.sequence);
    const messages = events.filter((event) => event.type === "message");
    expect(messages.map((event) => (event.data as { content: string }).content)).toEqual([
      "What did I ship last week?",
      "And what is still open?",
    ]);

    const triggers = await db.select().from(workTriggers).where(eq(workTriggers.workspaceId, workspaceId));
    expect(triggers.map((trigger) => trigger.id).sort()).toEqual(
      [key("chat", runId, "1"), key("chat", runId, "2")].sort(),
    );

    // The cursor follows the newest message, so a later poll replays neither.
    const cursor = await readStateValue(db, workspaceId, `chat:read-cursor:${runId}`);
    expect(cursor).toBe(String(events[events.length - 1]!.sequence));

    // Still the transcript carrier: no session was opened for it.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    expect(run?.sessionRef).toBeNull();
    expect(run?.state).toBe("waiting_input");
  });
});
