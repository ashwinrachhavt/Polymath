import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import { toolAllowed } from "../../../eve/alfred/agent/lib/policy";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import {
  AttemptAlreadyClaimedError,
  claimAttempt,
  findClaimedAttempt,
  settleAttempt,
} from "@/domains/actions/attempts";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import { NON_TERMINAL_RUN_STATES } from "@/domains/actions/executor";
import { getRunForGateway } from "@/domains/agents/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { IdempotencyConflictError } from "@/domains/audit/receipt";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  EventNotFoundError,
  EventVersionConflictError,
  InvalidRangeError,
  NoFreeSlotError,
  blockTimeForTask,
  cancelEvent,
  createEvent,
  moveEvent,
} from "./commands";

/*
 * Agent writes to the calendar are proposals (ASH-185, ADR 0006 Q5). An agent
 * proposes a time block, new event, move or cancel; the owner approves with
 * one tap and the approved revision executes through the same commands a
 * human uses. The effect is local to the workspace, so risk class is
 * "prepare": admins and owners may approve, members may only reject.
 *
 * Approval is not a licence to execute later: the run's snapshot and the
 * named account are re-read here, at execution time, the way the external
 * executor re-reads them. A capability revoked or a run cancelled between
 * proposal and approval must bite now, not at proposal time.
 *
 * Executing is replay-safe twice over: the command key is derived from the
 * proposal id, and an attempt row is claimed before the command runs, so a
 * crash between the call and its result leaves UNKNOWN evidence instead of
 * inviting a second booking.
 */

export type CalendarChange =
  | { kind: "block"; taskId: string; minutes?: number; utcOffsetMinutes?: number }
  | { kind: "create"; title: string; startsAt: string; endsAt: string }
  | { kind: "move"; eventId: string; expectedVersion: number; startsAt: string; endsAt: string; title?: string }
  | { kind: "cancel"; eventId: string; expectedVersion: number; title?: string };

/** The capability a profile must grant to propose a calendar change at all. */
const CALENDAR_PROPOSE_CAPABILITY = "calendar.propose";

const CAPABILITY = {
  block: "calendar.block",
  create: "calendar.event.create",
  move: "calendar.event.move",
  cancel: "calendar.event.cancel",
} as const;

function describe(change: CalendarChange): { title: string; effect: string } {
  switch (change.kind) {
    case "block":
      return {
        title: "Block time for a task",
        effect: `Adds a ${change.minutes ?? "default-length"} minute time block in the first free working-hours slot.`,
      };
    case "create":
      return { title: `Add event: ${change.title}`, effect: `Adds "${change.title}" on your calendar.` };
    case "move":
      return { title: `Move event${change.title ? `: ${change.title}` : ""}`, effect: "Moves the event to the proposed time." };
    case "cancel":
      return { title: `Cancel event${change.title ? `: ${change.title}` : ""}`, effect: "Removes the event from your calendar." };
  }
}

/** Agent entry point. `dedupeKey` is the agent's own intent key; replays resolve the same proposal. */
export async function proposeCalendarChange(
  auth: Pick<AuthContext, "workspaceId"> & { userId?: string | null },
  input: { change: CalendarChange; dedupeKey: string; runId?: string | null },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const { title, effect } = describe(input.change);
  return withTransaction(async (tx) => {
    const result = await createProposal(tx, auth, {
      capability: CAPABILITY[input.change.kind],
      riskClass: "prepare",
      targetType: "calendar",
      title,
      expectedEffect: effect,
      dedupeKey: `calendar:${input.dedupeKey}`,
      runId: input.runId ?? null,
    });
    if (!result.deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: result.proposalId,
        revisionNumber: 1,
        payload: input.change as Record<string, unknown>,
        preview: { title, effect },
        createdBy: auth.userId ?? null,
      });
    }
    return result;
  });
}

export type PendingCalendarProposal = {
  id: string;
  version: number;
  revisionId: string;
  title: string;
  effect: string;
};

export async function listPendingCalendarProposals(
  auth: Pick<AuthContext, "workspaceId">,
): Promise<PendingCalendarProposal[]> {
  const rows = await db
    .select({
      id: actionProposals.id,
      version: actionProposals.version,
      title: actionProposals.title,
      effect: actionProposals.expectedEffect,
      revisionId: sql<string>`(select r.id from action_revisions r where r.proposal_id = action_proposals.id order by r.revision_number desc limit 1)`,
    })
    .from(actionProposals)
    .where(
      and(
        eq(actionProposals.workspaceId, auth.workspaceId),
        eq(actionProposals.status, "pending"),
        like(actionProposals.capability, "calendar.%"),
      ),
    )
    .orderBy(asc(actionProposals.createdAt));
  return rows.filter((r) => r.revisionId);
}

export class CalendarExecuteNotAllowedError extends Error {
  readonly code = "calendar_execute_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "CalendarExecuteNotAllowedError";
  }
}

export type CalendarOutcome =
  | { status: "executed"; eventId: string }
  | { status: "unknown"; reconciliationId: string };

/*
 * Phase one: every check that can refuse, before an intent is claimed.
 *
 * The run check is skipped for a proposal a person created: there is no
 * snapshot to honour, and the approval itself is the authority. The account
 * check only applies when the proposal names an alias; local calendar events
 * name none, and inventing one would tie a local event to an external account
 * it never touches.
 */
async function prepare(auth: AuthContext, proposalId: string): Promise<void> {
  const [proposal] = await db
    .select({
      capability: actionProposals.capability,
      runId: actionProposals.runId,
      accountAlias: actionProposals.accountAlias,
    })
    .from(actionProposals)
    .where(and(eq(actionProposals.id, proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!proposal) throw new CalendarExecuteNotAllowedError("That proposal does not exist in this workspace.");

  if (proposal.runId) {
    const run = await getRunForGateway(proposal.runId, auth.workspaceId);
    if (!run) throw new CalendarExecuteNotAllowedError("The run that proposed this change no longer exists.");
    if (!NON_TERMINAL_RUN_STATES.has(run.state)) {
      throw new CalendarExecuteNotAllowedError("The run that proposed this change is no longer active.");
    }
    // The proposing capability is `calendar.propose`; the change-specific names
    // (calendar.event.create and friends) are effect identity, not what an
    // agent was granted. Checking those would deny every real proposal, because
    // no profile ever receives them.
    if (!toolAllowed(run.policySnapshot, CALENDAR_PROPOSE_CAPABILITY)) {
      throw new CalendarExecuteNotAllowedError(`The run's policy snapshot does not include ${CALENDAR_PROPOSE_CAPABILITY}.`);
    }
  }

  if (proposal.accountAlias) {
    const account = await resolveConnectedAccount(auth, "google-calendar", proposal.accountAlias);
    if (!account.ok) throw new CalendarExecuteNotAllowedError(account.message);
  }
}

/** The outcome a prior attempt already settled on; a claimed-but-unsettled row is UNKNOWN. */
async function claimedOutcome(auth: AuthContext, proposalId: string): Promise<CalendarOutcome | null> {
  const [prior] = await db
    .select()
    .from(actionAttempts)
    .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposalId)))
    .orderBy(desc(actionAttempts.attemptNumber))
    .limit(1);
  if (!prior) return null;
  if (prior.status === "unknown") return { status: "unknown", reconciliationId: prior.id };
  if (prior.status === "succeeded" && prior.providerObjectId) {
    return { status: "executed", eventId: prior.providerObjectId };
  }
  // A failed attempt is a definitive refusal; the command is replay-safe, so a
  // later approval may try again. An unresolved one never does.
  return null;
}

async function claim(auth: AuthContext, proposalId: string, revisionId: string): Promise<{ attemptId: string } | { prior: CalendarOutcome }> {
  const prior = await claimedOutcome(auth, proposalId);
  if (prior) return { prior };

  const idempotencyKey = `calendar-exec:${proposalId}`;
  try {
    const claimed = await withTransaction(async (tx) => {
      const [latest] = await tx
        .select({ attemptNumber: actionAttempts.attemptNumber })
        .from(actionAttempts)
        .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposalId)))
        .orderBy(desc(actionAttempts.attemptNumber))
        .limit(1);
      return claimAttempt(tx, {
        workspaceId: auth.workspaceId,
        proposalId,
        revisionId,
        idempotencyKey,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
      });
    });
    return { attemptId: claimed.attemptId };
  } catch (error) {
    if (!(error instanceof AttemptAlreadyClaimedError)) throw error;
    const winner = await withTransaction((tx) => findClaimedAttempt(tx, auth.workspaceId, idempotencyKey));
    return { prior: { status: "unknown", reconciliationId: winner?.id ?? proposalId } };
  }
}

async function runCommand(auth: AuthContext, proposalId: string, change: CalendarChange): Promise<string> {
  const idempotencyKey = `calendar-exec:${proposalId}`;
  switch (change.kind) {
    case "block":
      return (await blockTimeForTask(auth, { taskId: change.taskId, minutes: change.minutes, utcOffsetMinutes: change.utcOffsetMinutes, idempotencyKey })).id;
    case "create":
      return (await createEvent(auth, { title: change.title, startsAt: new Date(change.startsAt), endsAt: new Date(change.endsAt), idempotencyKey })).id;
    case "move":
      return (await moveEvent(auth, { eventId: change.eventId, expectedVersion: change.expectedVersion, startsAt: new Date(change.startsAt), endsAt: new Date(change.endsAt), title: change.title, idempotencyKey })).id;
    case "cancel":
      return (await cancelEvent(auth, { eventId: change.eventId, expectedVersion: change.expectedVersion, idempotencyKey })).id;
  }
}

/*
 * Phase two: claim, run, settle. The calendar command is a local transaction
 * rather than a provider call, but the discipline is the same: a claimed row
 * that never settles is UNKNOWN, and a retry reads that row instead of
 * guessing. A command error is a refusal, so it settles failed; only an
 * error we cannot classify (a connection lost after the write) is ambiguous.
 */
async function execute(auth: AuthContext, proposalId: string, revisionId: string, change: CalendarChange): Promise<CalendarOutcome> {
  await prepare(auth, proposalId);

  const claimed = await claim(auth, proposalId, revisionId);
  if ("prior" in claimed) return claimed.prior;
  const { attemptId } = claimed;

  let eventId: string | null = null;
  let refused: Error | null = null;
  let ambiguous: Error | null = null;
  try {
    eventId = await runCommand(auth, proposalId, change);
  } catch (error) {
    if (
      error instanceof EventNotFoundError ||
      error instanceof EventVersionConflictError ||
      error instanceof InvalidRangeError ||
      error instanceof NoFreeSlotError ||
      error instanceof IdempotencyConflictError ||
      (error instanceof Error && error.message.startsWith("task not found"))
    ) {
      refused = error;
    } else {
      // The command may have committed and then lost its reply. Settling
      // `failed` would invite a retry on a guess; UNKNOWN cannot double-book.
      ambiguous = error instanceof Error ? error : new Error("Unknown calendar failure.");
    }
  }

  await withTransaction(async (tx) => {
    if (eventId) {
      await settleAttempt(tx, { attemptId, outcome: "succeeded", providerObjectId: eventId });
      return;
    }
    if (refused) {
      await settleAttempt(tx, {
        attemptId,
        outcome: "failed",
        errorCode: "code" in refused ? String(refused.code) : "command_refused",
      });
      return;
    }
    await settleAttempt(tx, {
      attemptId,
      outcome: "unknown",
      errorCode: "calendar_outcome_unknown",
      responseSummary: { message: ambiguous?.message ?? "The command did not answer." },
    });
  });

  // Thrown outside the settle's transaction: a refusal is still a settled
  // attempt, and throwing inside would roll the evidence back to UNKNOWN.
  if (refused) throw refused;
  if (eventId) return { status: "executed", eventId };
  return { status: "unknown", reconciliationId: attemptId };
}

/** One-tap approve: records the decision, then runs the approved revision. Safe to call again after a crash. */
export async function approveCalendarProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<CalendarOutcome> {
  try {
    await decideProposal(auth, {
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      decision: "approved",
      idempotencyKey: `calendar-decide:${input.proposalId}`,
    });
  } catch (error) {
    // Already approved (a retry): fall through to the replay-safe execution.
    if (!(error instanceof ProposalConflictError)) throw error;
    const [p] = await db
      .select({ status: actionProposals.status })
      .from(actionProposals)
      .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (p?.status !== "approved") throw error;
  }
  const [revision] = await db
    .select({ payload: actionRevisions.payload })
    .from(actionRevisions)
    .where(and(eq(actionRevisions.id, input.revisionId), eq(actionRevisions.workspaceId, auth.workspaceId)))
    .orderBy(desc(actionRevisions.revisionNumber))
    .limit(1);
  if (!revision) throw new Error("revision not found");
  return execute(auth, input.proposalId, input.revisionId, revision.payload as CalendarChange);
}

export async function rejectCalendarProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
) {
  return decideProposal(auth, { ...input, decision: "rejected", idempotencyKey: `calendar-decide:${input.proposalId}` });
}
