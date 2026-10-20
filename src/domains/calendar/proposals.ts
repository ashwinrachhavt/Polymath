import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { blockTimeForTask, cancelEvent, createEvent, moveEvent } from "./commands";

/*
 * Agent writes to the calendar are proposals (ASH-185, ADR 0006 Q5). An agent
 * proposes a time block, new event, move or cancel; the owner approves with
 * one tap and the approved revision executes through the same commands a
 * human uses. The effect is local to the workspace, so risk class is
 * "prepare": admins and owners may approve, members may only reject.
 *
 * Executing is replay-safe: the command key is derived from the proposal id,
 * so a retry after a crash between "approved" and "executed" does not
 * double-book.
 */

export type CalendarChange =
  | { kind: "block"; taskId: string; minutes?: number; utcOffsetMinutes?: number }
  | { kind: "create"; title: string; startsAt: string; endsAt: string }
  | { kind: "move"; eventId: string; expectedVersion: number; startsAt: string; endsAt: string; title?: string }
  | { kind: "cancel"; eventId: string; expectedVersion: number; title?: string };

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
  auth: AuthContext,
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
        createdBy: auth.userId,
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

async function execute(auth: AuthContext, proposalId: string, change: CalendarChange) {
  const idempotencyKey = `calendar-exec:${proposalId}`;
  switch (change.kind) {
    case "block":
      return blockTimeForTask(auth, { taskId: change.taskId, minutes: change.minutes, utcOffsetMinutes: change.utcOffsetMinutes, idempotencyKey });
    case "create":
      return createEvent(auth, { title: change.title, startsAt: new Date(change.startsAt), endsAt: new Date(change.endsAt), idempotencyKey });
    case "move":
      return moveEvent(auth, { eventId: change.eventId, expectedVersion: change.expectedVersion, startsAt: new Date(change.startsAt), endsAt: new Date(change.endsAt), title: change.title, idempotencyKey });
    case "cancel":
      return cancelEvent(auth, { eventId: change.eventId, expectedVersion: change.expectedVersion, idempotencyKey });
  }
}

/** One-tap approve: records the decision, then runs the approved revision. Safe to call again after a crash. */
export async function approveCalendarProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<{ executed: true }> {
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
  await execute(auth, input.proposalId, revision.payload as CalendarChange);
  return { executed: true };
}

export async function rejectCalendarProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
) {
  return decideProposal(auth, { ...input, decision: "rejected", idempotencyKey: `calendar-decide:${input.proposalId}` });
}
