import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionAttempts, actionProposals } from "@/domains/actions/schema";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Calendar's execution path enforces the same three checks as the external
 * executor, because the gateway is only "one checkpoint" if the local one is
 * not a way around it:
 *  1. the run's frozen snapshot still allows the capability;
 *  2. the run is still non-terminal;
 *  3. a named account is still active;
 * plus the attempt row that turns a crash into evidence instead of a retry.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let proposals: typeof import("@/domains/calendar/proposals");
let work: typeof import("@/domains/work/commands");
let queries: typeof import("@/domains/calendar/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  proposals = await import("@/domains/calendar/proposals");
  work = await import("@/domains/work/commands");
  queries = await import("@/domains/calendar/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

const from = new Date(Date.UTC(2030, 0, 7, 0, 0));

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

type RunState = typeof agentRuns.$inferInsert.state;

async function seedRun(workspaceId: string, userId: string, allowedTools: string[], state: RunState = "running") {
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `alfred-${crypto.randomUUID()}` })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "Block time",
      state,
      policySnapshot: { allowedTools },
      createdBy: userId,
    })
    .returning();
  return run.id;
}

async function proposeWithRun(
  auth: ReturnType<typeof ownerAuth>,
  runId: string,
  change: Parameters<typeof proposals.proposeCalendarChange>[1]["change"],
) {
  const { proposalId } = await proposals.proposeCalendarChange(auth, {
    change,
    dedupeKey: `run-${runId}-${crypto.randomUUID()}`,
    runId,
  });
  const [pending] = (await proposals.listPendingCalendarProposals(auth)).filter((p) => p.id === proposalId);
  return { proposalId, pending };
}

async function attemptsFor(proposalId: string) {
  return db
    .select()
    .from(actionAttempts)
    .where(eq(actionAttempts.proposalId, proposalId))
    .orderBy(desc(actionAttempts.attemptNumber));
}

suite("calendar proposal execution checks", () => {
  it("refuses when the run's snapshot does not grant the capability", async () => {
    const { auth, userId, workspaceId } = await seed("cal-exec-cap");
    // The snapshot is frozen at run start and the database rejects edits to it,
    // so execution must honour what it actually says: a run granted calendar
    // reads but not calendar.propose never executes a proposal.
    const runId = await seedRun(workspaceId, userId, ["calendar.read"]);
    const task = await work.createOwnerTask(auth, { title: "Deep work", estimateMinutes: 60 });
    const { proposalId, pending } = await proposeWithRun(auth, runId, { kind: "block", taskId: task.id, minutes: 60 });

    await expect(
      proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId }),
    ).rejects.toBeInstanceOf(proposals.CalendarExecuteNotAllowedError);

    expect(await queries.listEventsBetween(auth, new Date(Date.now() - 86_400_000), new Date(Date.now() + 30 * 86_400_000))).toHaveLength(0);
    expect(await attemptsFor(proposalId)).toHaveLength(0);
  });

  it("refuses when the run that proposed it is cancelled", async () => {
    const { auth, userId, workspaceId } = await seed("cal-exec-run");
    const runId = await seedRun(workspaceId, userId, ["calendar.propose"]);
    const { proposalId, pending } = await proposeWithRun(auth, runId, {
      kind: "create",
      title: "Review",
      startsAt: from.toISOString(),
      endsAt: new Date(from.getTime() + 3_600_000).toISOString(),
    });
    await db.update(agentRuns).set({ state: "cancelled" }).where(eq(agentRuns.id, runId));

    await expect(
      proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId }),
    ).rejects.toBeInstanceOf(proposals.CalendarExecuteNotAllowedError);
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(0);
  });

  it("refuses a named account that is no longer active", async () => {
    const { auth, userId, workspaceId } = await seed("cal-exec-account");
    const alias = `cal-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(externalAccounts).values({
      workspaceId,
      provider: "google-calendar",
      alias,
      status: "revoked",
      composioConnectedAccountId: null,
      createdBy: userId,
      updatedBy: userId,
    });
    const { proposalId: created } = await proposals.proposeCalendarChange(auth, {
      change: { kind: "create", title: "Revoked", startsAt: from.toISOString(), endsAt: new Date(from.getTime() + 3_600_000).toISOString() },
      dedupeKey: `revoked-${crypto.randomUUID()}`,
    });
    // The alias is only ever set by a caller that means an external destination.
    await db.update(actionProposals).set({ accountAlias: alias }).where(eq(actionProposals.id, created));
    const [pending] = (await proposals.listPendingCalendarProposals(auth)).filter((p) => p.id === created);

    await expect(
      proposals.approveCalendarProposal(auth, { proposalId: created, expectedVersion: pending.version, revisionId: pending.revisionId }),
    ).rejects.toBeInstanceOf(proposals.CalendarExecuteNotAllowedError);
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(0);
  });

  it("skips the account check for a proposal with no alias", async () => {
    // Calendar events are local; with no google-calendar account connected and
    // no alias on the proposal, execution must still work.
    const { auth } = await seed("cal-exec-no-alias");
    const { proposalId } = await proposals.proposeCalendarChange(auth, {
      change: { kind: "create", title: "Local only", startsAt: from.toISOString(), endsAt: new Date(from.getTime() + 3_600_000).toISOString() },
      dedupeKey: `local-${crypto.randomUUID()}`,
    });
    const [pending] = (await proposals.listPendingCalendarProposals(auth)).filter((p) => p.id === proposalId);
    const outcome = await proposals.approveCalendarProposal(auth, {
      proposalId,
      expectedVersion: pending.version,
      revisionId: pending.revisionId,
    });
    expect(outcome.status).toBe("executed");
  });

  it("claims the attempt before the command, and settles a refusal as failed", async () => {
    // A move against an event that does not exist refuses inside the command.
    // The failed attempt proves the claim was already written when it ran.
    const { auth } = await seed("cal-exec-claim");
    const { proposalId } = await proposals.proposeCalendarChange(auth, {
      change: {
        kind: "move",
        eventId: crypto.randomUUID(),
        expectedVersion: 1,
        startsAt: from.toISOString(),
        endsAt: new Date(from.getTime() + 3_600_000).toISOString(),
      },
      dedupeKey: `missing-${crypto.randomUUID()}`,
    });
    const [pending] = (await proposals.listPendingCalendarProposals(auth)).filter((p) => p.id === proposalId);

    await expect(
      proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId }),
    ).rejects.toMatchObject({ code: "event_not_found" });

    const attempts = await attemptsFor(proposalId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].idempotencyKey).toBe(`calendar-exec:${proposalId}`);
  });

  it("records a successful execution and replays it without a second event", async () => {
    const { auth } = await seed("cal-exec-once");
    const { proposalId } = await proposals.proposeCalendarChange(auth, {
      change: { kind: "create", title: "Once", startsAt: from.toISOString(), endsAt: new Date(from.getTime() + 3_600_000).toISOString() },
      dedupeKey: `once-${crypto.randomUUID()}`,
    });
    const [pending] = (await proposals.listPendingCalendarProposals(auth)).filter((p) => p.id === proposalId);
    const first = await proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId });
    expect(first.status).toBe("executed");

    const second = await proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId });
    expect(second).toEqual(first);

    const attempts = await attemptsFor(proposalId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("succeeded");
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(1);
  });

  it("a crash-shaped attempt is not retried into a duplicate event", async () => {
    const { auth, workspaceId } = await seed("cal-exec-crash");
    const { proposalId } = await proposals.proposeCalendarChange(auth, {
      change: { kind: "create", title: "Crash", startsAt: from.toISOString(), endsAt: new Date(from.getTime() + 3_600_000).toISOString() },
      dedupeKey: `crash-${crypto.randomUUID()}`,
    });
    const [pending] = (await proposals.listPendingCalendarProposals(auth)).filter((p) => p.id === proposalId);
    // What a crash between the claim and the settle leaves behind.
    await db.insert(actionAttempts).values({
      workspaceId,
      proposalId,
      revisionId: pending.revisionId,
      idempotencyKey: `calendar-exec:${proposalId}`,
      attemptNumber: 1,
      status: "unknown",
      reconciliation: "pending",
    });

    const outcome = await proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId });
    expect(outcome.status).toBe("unknown");
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(0);

    // A replay reads the unresolved attempt, never the command.
    const replay = await proposals.approveCalendarProposal(auth, { proposalId, expectedVersion: pending.version, revisionId: pending.revisionId });
    expect(replay.status).toBe("unknown");
    expect(await attemptsFor(proposalId)).toHaveLength(1);
    expect(await queries.listEventsBetween(auth, from, new Date(from.getTime() + 7 * 86_400_000))).toHaveLength(0);
  });
});
