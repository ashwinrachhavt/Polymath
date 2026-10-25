import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { auditEvents, outboxEvents } from "@/domains/audit/schema";
import { contacts, followUps } from "@/domains/crm/schema";
import { spendingReservations } from "@/domains/spending/schema";
import { taskLinks } from "@/domains/work/schema";
import type { AuthContext } from "@/lib/auth";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Commit/Focus hand-off (ASH-288). A finished focus session earns ONE
 * delegated Writer run when - and only when - its task links resolve to
 * exactly one external party. No party and no unambiguous party both mean no
 * run, no spend; the audit row is the only trace. A redelivered event never
 * double-starts.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let followUp: typeof import("@/domains/focus/follow-up");
let calendarCmd: typeof import("@/domains/calendar/commands");
let focusCmd: typeof import("@/domains/focus/commands");
let workCmd: typeof import("@/domains/work/commands");
let writerDraft: typeof import("@/domains/agents/writer-draft");

const BRIDGE_SECRET = "f".repeat(40);
const savedSecret = process.env.EVE_BRIDGE_SECRET;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  calendarCmd = await import("@/domains/calendar/commands");
  followUp = await import("@/domains/focus/follow-up");
  writerDraft = await import("@/domains/agents/writer-draft");
  focusCmd = await import("@/domains/focus/commands");
  workCmd = await import("@/domains/work/commands");
  process.env.EVE_BRIDGE_SECRET = BRIDGE_SECRET;
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.EVE_BRIDGE_SECRET;
  else process.env.EVE_BRIDGE_SECRET = savedSecret;
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function seedAlfred(auth: AuthContext) {
  await db
    .insert(agentProfiles)
    .values({ workspaceId: auth.workspaceId, name: "alfred", createdBy: auth.userId, updatedBy: auth.userId });
}

async function linkContact(auth: AuthContext, taskId: string, name: string, email: string | null) {
  const [contact] = await db
    .insert(contacts)
    .values({
      workspaceId: auth.workspaceId,
      fullName: name,
      primaryEmail: email,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  await db.insert(taskLinks).values({
    workspaceId: auth.workspaceId,
    taskId,
    targetType: "contact",
    targetId: contact.id,
  });
  return contact;
}

async function finishSessionOn(auth: AuthContext, taskId: string) {
  const session = await focusCmd.startFocusSession(auth, { taskId });
  return focusCmd.finishFocusSession(auth, {
    sessionId: session.id,
    expectedVersion: session.version,
    outcome: "Draft sent for review",
    nextStep: "Send the revised proposal",
  });
}

const fakeDriver = () => {
  const starts: string[] = [];
  return {
    starts,
    driver: {
      async start(input: { objective: string }) {
        starts.push(input.objective);
      },
      async signal() {},
      async cancel() {},
    },
  };
};

const asEvent = (workspaceId: string, sessionId: string) =>
  ({ workspaceId, payload: { sessionId } }) as Parameters<
    ReturnType<typeof followUp.followUpRequestedHandler>
  >[0];

const runCount = async (workspaceId: string) =>
  (await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId))).length;

const auditActions = async (workspaceId: string) =>
  (
    await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId))
  ).map((row) => row.action);

suite("focus follow-up hand-off", () => {
  it("enqueues the hand-off event in the finish transaction, deduped on the session", async () => {
    const auth = await seed("fu-enqueue");
    const task = await workCmd.createOwnerTask(auth, { title: "Prepare the Acme proposal" });
    const session = await finishSessionOn(auth, task.id);

    const events = await db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.workspaceId, auth.workspaceId), eq(outboxEvents.topic, followUp.FOCUS_FOLLOW_UP_TOPIC)),
      );
    expect(events).toHaveLength(1);
    expect(events[0].dispatchKey).toBe(session.id);
    expect((events[0].payload as { sessionId: string }).sessionId).toBe(session.id);
  });

  it("starts one Writer run for a resolved party, with budget reserved and the audit row", async () => {
    const auth = await seed("fu-run");
    await seedAlfred(auth);
    const task = await workCmd.createOwnerTask(auth, { title: "Prepare the Acme proposal" });
    const contact = await linkContact(auth, task.id, "Riya Sen", "riya@example.com");
    const session = await finishSessionOn(auth, task.id);
    const { driver, starts } = fakeDriver();

    const handler = followUp.followUpRequestedHandler(async () => auth, driver);
    await handler(asEvent(auth.workspaceId, session.id));

    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("Prepare the Acme proposal");
    expect(starts[0]).toContain("Riya Sen");

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.workspaceId, auth.workspaceId));
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("running");
    const subjects = runs[0].subjects as Array<{ type: string; id: string }>;
    expect(subjects).toContainEqual({ type: "focus_session", id: session.id });
    expect(subjects).toContainEqual({ type: "task", id: task.id });
    expect(subjects).toContainEqual({ type: "contact", id: contact.id });

    const reservations = await db
      .select()
      .from(spendingReservations)
      .where(
        and(eq(spendingReservations.workspaceId, auth.workspaceId), eq(spendingReservations.runId, runs[0].id)),
      );
    expect(reservations).toHaveLength(1);
    expect(await auditActions(auth.workspaceId)).toContain("focus.follow_up_started");
  });

  it("a redelivered event never double-starts the run", async () => {
    const auth = await seed("fu-replay");
    await seedAlfred(auth);
    const task = await workCmd.createOwnerTask(auth, { title: "Replay guard" });
    await linkContact(auth, task.id, "Riya Sen", "riya@example.com");
    const session = await finishSessionOn(auth, task.id);
    const { driver } = fakeDriver();
    const handler = followUp.followUpRequestedHandler(async () => auth, driver);

    await handler(asEvent(auth.workspaceId, session.id));
    await handler(asEvent(auth.workspaceId, session.id));
    expect(await runCount(auth.workspaceId)).toBe(1);
  });

  it("no linked party means no run, no spend, and a silent skip with only an audit row", async () => {
    const auth = await seed("fu-none");
    const task = await workCmd.createOwnerTask(auth, { title: "Solo task" });
    const session = await finishSessionOn(auth, task.id);
    const { driver, starts } = fakeDriver();

    await followUp.followUpRequestedHandler(async () => auth, driver)(asEvent(auth.workspaceId, session.id));

    expect(starts).toHaveLength(0);
    expect(await runCount(auth.workspaceId)).toBe(0);
    const actions = await auditActions(auth.workspaceId);
    expect(actions).toContain("focus.follow_up_skipped");
    expect(actions).not.toContain("focus.follow_up_started");
  });

  it("an ambiguous resolution never guesses a recipient: no run, and the audit row says why", async () => {
    const auth = await seed("fu-ambiguous");
    const task = await workCmd.createOwnerTask(auth, { title: "Two parties" });
    await linkContact(auth, task.id, "Riya Sen", "riya@example.com");
    await linkContact(auth, task.id, "Marcus Cole", "marcus@example.com");
    const session = await finishSessionOn(auth, task.id);
    const { driver, starts } = fakeDriver();

    await followUp.followUpRequestedHandler(async () => auth, driver)(asEvent(auth.workspaceId, session.id));

    expect(starts).toHaveLength(0);
    expect(await runCount(auth.workspaceId)).toBe(0);
    const [skip] = await db
      .select({ summary: auditEvents.summary })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "focus.follow_up_skipped")));
    expect(skip.summary).toContain("no recipient was guessed");
  });

  it("a bridge-down start skips with the same reason the owner sees elsewhere", async () => {
    const auth = await seed("fu-bridge-down");
    const task = await workCmd.createOwnerTask(auth, { title: "Bridge check" });
    await linkContact(auth, task.id, "Riya Sen", "riya@example.com");
    const session = await finishSessionOn(auth, task.id);
    const { driver, starts } = fakeDriver();

    delete process.env.EVE_BRIDGE_SECRET;
    try {
      await followUp.followUpRequestedHandler(async () => auth, driver)(asEvent(auth.workspaceId, session.id));
    } finally {
      process.env.EVE_BRIDGE_SECRET = BRIDGE_SECRET;
    }

    expect(starts).toHaveLength(0);
    expect(await runCount(auth.workspaceId)).toBe(0);
    const [skip] = await db
      .select({ summary: auditEvents.summary })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "focus.follow_up_skipped")));
    expect(skip.summary).toContain("EVE_BRIDGE_SECRET");
  });

  it("a session without a task enqueues nothing", async () => {
    const auth = await seed("fu-no-task");
    const session = await focusCmd.startFocusSession(auth, { subject: "Inbox zero" });
    await focusCmd.finishFocusSession(auth, { sessionId: session.id, expectedVersion: session.version });
    const events = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.workspaceId, auth.workspaceId), eq(outboxEvents.topic, followUp.FOCUS_FOLLOW_UP_TOPIC)),
      );
    expect(events).toHaveLength(0);
  });
});

suite("the Writer pass files the pair", () => {
  const fakeProvider = {
    name: "fake",
    registryId: "fake",
    async generate() {
      return {
        text: JSON.stringify({
          emailSubject: "The revised proposal",
          emailBody: "Thanks for today - the revised proposal is attached.",
          reminderSummary: "Check the proposal landed",
          suggestedDaysAhead: 2,
        }),
      };
    },
  };

  async function seedRunRow(auth: AuthContext) {
    const [profile] = await db
      .insert(agentProfiles)
      .values({ workspaceId: auth.workspaceId, name: "alfred", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    const [run] = await db
      .insert(agentRuns)
      .values({
        workspaceId: auth.workspaceId,
        agentProfileId: profile.id,
        objective: "Draft the follow-up pair",
        policySnapshot: {},
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    return run;
  }

  it("files one reminder proposal (replay dedupes), no email without an address on the contact", async () => {
    const auth = await seed("fu-writer");
    const task = await workCmd.createOwnerTask(auth, { title: "Prepare the Acme proposal" });
    const contact = await linkContact(auth, task.id, "Riya Sen", null);
    const run = await seedRunRow(auth);
    const sessionId = crypto.randomUUID();
    const input = {
      runId: run.id,
      sessionId,
      contactId: contact.id,
      taskId: task.id,
      session: { outcome: "Draft sent", whatChanged: null, nextStep: "Send the revised proposal", endedAt: new Date() },
      taskTitle: "Prepare the Acme proposal",
      contact: { fullName: "Riya Sen", primaryEmail: null },
    };

    const first = await writerDraft.draftFollowUp(auth, input, { provider: fakeProvider });
    expect(first.emailProposalId).toBeNull();
    expect(first.reminderStartsAt > new Date().toISOString()).toBe(true);

    const proposals = await db
      .select()
      .from(actionProposals)
      .where(
        and(
          eq(actionProposals.workspaceId, auth.workspaceId),
          eq(actionProposals.dedupeKey, `calendar:followup-reminder:${sessionId}`),
        ),
      );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].capability).toBe("calendar.event.create");
    expect(proposals[0].runId).toBe(run.id);

    const again = await writerDraft.draftFollowUp(auth, input, { provider: fakeProvider });
    expect(again.reminderProposalId).toBe(first.reminderProposalId);
  });

  it("a second approved reminder supersedes the first rather than stacking", async () => {
    const auth = await seed("fu-supersede");
    const task = await workCmd.createOwnerTask(auth, { title: "Keep the thread warm" });
    const contact = await linkContact(auth, task.id, "Riya Sen", "riya@example.com");
    const at = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const end = new Date(at.getTime() + 30 * 60 * 1000);

    const first = await calendarCmd.createFollowUpReminder(auth, {
      idempotencyKey: "reminder-1",
      title: "Follow up: Keep the thread warm",
      startsAt: at,
      endsAt: end,
      reason: "Check the proposal landed",
      contactId: contact.id,
      taskId: task.id,
    });
    const second = await calendarCmd.createFollowUpReminder(auth, {
      idempotencyKey: "reminder-2",
      title: "Follow up: Keep the thread warm",
      startsAt: new Date(at.getTime() + 24 * 3600 * 1000),
      endsAt: new Date(end.getTime() + 24 * 3600 * 1000),
      reason: "Ping again after the board meeting",
      contactId: contact.id,
      taskId: task.id,
    });

    expect(second.superseded).toBe(1);
    const rows = await db
      .select()
      .from(followUps)
      .where(and(eq(followUps.workspaceId, auth.workspaceId), eq(followUps.taskId, task.id)));
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => row.id === first.followUpId)!;
    const current = rows.find((row) => row.id === second.followUpId)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBe(second.followUpId);
    expect(current.status).toBe("open");
  });
});
