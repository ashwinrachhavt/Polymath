import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns } from "@/domains/agents/schema";
import { key } from "@/domains/superagent/core";
import type { Outcome } from "@/domains/superagent/core";
import { policyVersion } from "@/domains/superagent/core/policy/gate";
import { readStateValue } from "@/domains/superagent/store";
import { workDecisions, workEffects, workTickets, workTriggers } from "@/domains/superagent/store";
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
let startSuperagentConversation: typeof import("@/domains/superagent/wiring").startSuperagentConversation;
let superagentForWorkspace: typeof import("@/domains/superagent/wiring").superagentForWorkspace;

beforeAll(async () => {
  if (!handle) return;
  db = handle.db;
  ({ ensureProfile } = await import("@/domains/agents/commands"));
  ({ startSuperagentConversation, superagentForWorkspace } = await import("@/domains/superagent/wiring"));
});

afterAll(async () => {
  await handle?.client.end();
});

suite("the chat cutover", () => {
  it("turns a chat message into a trigger, an assessment, and an accepted ticket", async () => {
    // A unique slug per run: the seeded user's clerk id derives from it, and
    // a rerun against a persistent scratch database must not collide.
    const { userId, workspaceId } = await seedWorkspace(db, `superagent-cutover-${Date.now()}`);
    await ensureProfile(workspaceId, "polymath");
    const auth = ownerAuth(userId, workspaceId);
    const message = "Draft the Q3 plan and circulate it for review";

    const { runId, received } = await startSuperagentConversation({
      auth,
      profileName: "polymath",
      message,
    });
    expect(received).toBe("stored");

    // The conversation carrier: a sessionless waiting_input run whose
    // objective is the person's words — the transcript the Source reads,
    // never the work itself.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    expect(run?.state).toBe("waiting_input");
    expect(run?.sessionRef).toBeNull();
    expect(run?.objective).toBe(message);

    // The Trigger: immutable, on the chat Source, with the plugin's stable
    // id (same event, same id — the replay-safety contract).
    const triggers = await db.select().from(workTriggers).where(eq(workTriggers.workspaceId, workspaceId));
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.id).toBe(key("chat", runId, "1"));
    expect(trigger.text).toBe(message);
    expect((trigger.actor as { id: string }).id).toBe(userId);

    // The read position advanced only after the trigger was stored, so a
    // crash before it replays as a duplicate rather than a lost message.
    // (The Source's cursor key is namespaced per plugin: chat:read-cursor.)
    const cursor = await readStateValue(db, workspaceId, `chat:read-cursor:${runId}`);
    expect(cursor).toBe("1");

    // The assessment step: the drain queued the assessor's effect durably
    // inside the receive transaction (attempts may already count the inline
    // pass's try; existence is the invariant, not its attempt count).
    const assessmentEffects = await db
      .select()
      .from(workEffects)
      .where(and(eq(workEffects.workspaceId, workspaceId), eq(workEffects.kind, "assessment")));
    expect(assessmentEffects).toHaveLength(1);

    // The decision, through the Engine — the same command the assessor's
    // eval session records through orchestrator_eval_decide.
    const host = await superagentForWorkspace(workspaceId);
    const accept: Outcome = {
      kind: "accept",
      title: "Q3 plan",
      scope: "Draft the Q3 plan and circulate it for review",
      reason: "the person asked for it directly",
    };
    // The person's accept through the Engine: the decision records `accept`
    // and the ticket id it opened. The store is write-behind — the wiring
    // flushes after every command, and so does the test before it queries.
    const decision = host.engine.decide(trigger.id, accept);
    expect(decision.kind).toBe("accept");
    expect(decision.ticketId).toBeTruthy();
    await host.flush();

    // The Ticket: open, with its Mandate frozen at the policy's version —
    // one revision hash over the rules, the accept mode, and the source
    // parts (strength and accept mode ride the snapshot, no parallel table).
    const tickets = await db
      .select()
      .from(workTickets)
      .where(and(eq(workTickets.workspaceId, workspaceId), eq(workTickets.id, decision.ticketId!)));
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0]!;
    expect(ticket.endedAt).toBeNull();
    expect(ticket.mandate.strength).toBe("explicit");
    expect(ticket.mandate.policyVersion).toBe(policyVersion(host.config));

    // The decision is on the record (an accept decision, ticket id attached),
    // and the launch effect waits behind it.
    const decisions = await db.select().from(workDecisions).where(eq(workDecisions.ticketId, ticket.id));
    expect(decisions.some((row) => row.kind === "accept")).toBe(true);
    // The launch effect waits behind the decision (keyed by the ticket run —
    // one launch per run — with the ticket id in its payload).
    const launchEffects = await db
      .select()
      .from(workEffects)
      .where(and(eq(workEffects.workspaceId, workspaceId), eq(workEffects.kind, "launch")));
    expect(launchEffects.some((row) => (row.payload as { ticketId?: string }).ticketId === ticket.id)).toBe(true);

    // Replay safety at the intake: the same trigger id is a duplicate, not a
    // second ticket.
    const replay = host.engine.receive({
      id: trigger.id,
      source: "chat",
      threads: [{ source: "chat", id: "t1" }],
      actor: { source: "chat", id: userId },
      human: true,
      at: new Date().toISOString(),
      text: message,
      meta: {},
    });
    expect(replay).toBe("duplicate");
  });
});
