import { and, desc, eq } from "drizzle-orm";
import { toolAllowed } from "../../../eve/alfred/agent/lib/policy";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import { NON_TERMINAL_RUN_STATES } from "@/domains/actions/executor";
import { getRunForGateway } from "@/domains/agents/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { claimAttempt, AttemptAlreadyClaimedError, findClaimedAttempt, settleAttempt } from "@/domains/actions/attempts";
import { linkTargetKinds } from "@/db/columns";
import { createTask, type TaskLinkInput } from "./commands";

/*
 * Agent-proposed tasks. A run that reads source material and sees follow-up
 * work cannot create a task itself: the agent tool surface is read-only, so
 * the follow-up lands here as a proposal in the review queue. Approving it
 * runs the exact revision through the local claim/settle discipline - the
 * same one calendar uses - because "the agent suggested it" is not authority
 * to write, and a retried approval must never create the task twice.
 */

const TASKS_PROPOSE_CAPABILITY = "tasks.create";

export type TaskProposalPayload = {
  title: string;
  description?: string;
  dueAt?: string;
  estimateMinutes?: number;
  links?: TaskLinkInput[];
};

export class TaskExecuteNotAllowedError extends Error {
  readonly code = "task_execute_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "TaskExecuteNotAllowedError";
  }
}

/** Agent entry point. `dedupeKey` is the agent's own intent key; replays resolve the same proposal. */
export async function proposeTask(
  auth: Pick<AuthContext, "workspaceId"> & { userId?: string | null },
  input: TaskProposalPayload & { dedupeKey: string; runId?: string | null },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const title = input.title.trim().slice(0, 500);
  return withTransaction(async (tx) => {
    const result = await createProposal(tx, auth, {
      capability: TASKS_PROPOSE_CAPABILITY,
      riskClass: "prepare",
      targetType: "task",
      title: `Add task: ${title}`,
      expectedEffect: `Creates the task "${title}" in your inbox.`,
      dedupeKey: `tasks:${input.dedupeKey}`,
      runId: input.runId ?? null,
    });
    if (!result.deduplicated) {
      const payload: Record<string, unknown> = { title };
      if (input.description) payload.description = input.description;
      if (input.dueAt) payload.dueAt = input.dueAt;
      if (input.estimateMinutes) payload.estimateMinutes = input.estimateMinutes;
      if (input.links?.length) payload.links = input.links;
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: result.proposalId,
        revisionNumber: 1,
        payload,
        preview: { title, description: input.description ?? null },
        createdBy: auth.userId ?? null,
      });
    }
    return result;
  });
}

/*
 * Every check that can refuse, before an intent is claimed. A proposal a
 * person created carries no run to honour; an agent-created one is checked
 * against the run's frozen snapshot and state, the same checkpoint the
 * gateway and the calendar executor enforce.
 */
async function prepare(auth: AuthContext, proposalId: string): Promise<void> {
  const [proposal] = await db
    .select({
      capability: actionProposals.capability,
      runId: actionProposals.runId,
      status: actionProposals.status,
      expiresAt: actionProposals.expiresAt,
    })
    .from(actionProposals)
    .where(and(eq(actionProposals.id, proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!proposal) throw new TaskExecuteNotAllowedError("That proposal does not exist in this workspace.");
  if (proposal.capability !== TASKS_PROPOSE_CAPABILITY) {
    throw new TaskExecuteNotAllowedError("That proposal is not a task proposal.");
  }
  if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
    throw new TaskExecuteNotAllowedError("This proposal expired before it was executed.");
  }

  if (proposal.runId) {
    const run = await getRunForGateway(proposal.runId, auth.workspaceId);
    if (!run) throw new TaskExecuteNotAllowedError("The run that proposed this task no longer exists.");
    if (!NON_TERMINAL_RUN_STATES.has(run.state)) {
      throw new TaskExecuteNotAllowedError("The run that proposed this task is no longer active.");
    }
    if (!toolAllowed(run.policySnapshot, TASKS_PROPOSE_CAPABILITY)) {
      throw new TaskExecuteNotAllowedError(`The run's policy snapshot does not include ${TASKS_PROPOSE_CAPABILITY}.`);
    }
  }
}

export type TaskOutcome =
  | { status: "executed"; taskId: string }
  | { status: "unknown"; reconciliationId: string };

/** The outcome a prior attempt already settled on; a claimed-but-unsettled row is UNKNOWN. */
async function claimedOutcome(auth: AuthContext, proposalId: string): Promise<TaskOutcome | null> {
  const [prior] = await db
    .select()
    .from(actionAttempts)
    .where(and(eq(actionAttempts.workspaceId, auth.workspaceId), eq(actionAttempts.proposalId, proposalId)))
    .orderBy(desc(actionAttempts.attemptNumber))
    .limit(1);
  if (!prior) return null;
  if (prior.status === "unknown") return { status: "unknown", reconciliationId: prior.id };
  if (prior.status === "succeeded" && prior.providerObjectId) {
    return { status: "executed", taskId: prior.providerObjectId };
  }
  // A failed attempt is a definitive refusal; the command is replay-safe, so
  // a later approval may try again. An unresolved one never does.
  return null;
}

async function claim(auth: AuthContext, proposalId: string, revisionId: string): Promise<{ attemptId: string } | { prior: TaskOutcome }> {
  const prior = await claimedOutcome(auth, proposalId);
  if (prior) return { prior };

  const idempotencyKey = `tasks-exec:${proposalId}`;
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

const LINK_KINDS = new Set<string>(linkTargetKinds);

/* The owner may revise the payload as free JSON, so execute re-validates. */
function parsePayload(payload: unknown): TaskProposalPayload {
  const p = payload as TaskProposalPayload;
  if (!p || typeof p.title !== "string" || !p.title.trim()) {
    throw new TaskExecuteNotAllowedError("The approved payload is not a valid task.");
  }
  if (p.dueAt !== undefined && Number.isNaN(new Date(p.dueAt).getTime())) {
    throw new TaskExecuteNotAllowedError("The approved payload has an unparseable due date.");
  }
  if (p.links !== undefined) {
    if (!Array.isArray(p.links) || p.links.some((l) => !l || typeof l.targetId !== "string" || !LINK_KINDS.has(l.targetType))) {
      throw new TaskExecuteNotAllowedError("The approved payload has a link kind this workspace does not use.");
    }
  }
  return p;
}

/*
 * Phase two: claim, create, settle. createTask is a local transaction rather
 * than a provider call, but the discipline is the same: a claimed row that
 * never settles is UNKNOWN, and a retry reads that row instead of creating a
 * second task on a guess.
 */
async function execute(auth: AuthContext, proposalId: string, revisionId: string, payload: TaskProposalPayload): Promise<TaskOutcome> {
  await prepare(auth, proposalId);

  const claimed = await claim(auth, proposalId, revisionId);
  if ("prior" in claimed) return claimed.prior;
  const { attemptId } = claimed;

  let taskId: string | null = null;
  let refused: Error | null = null;
  let ambiguous: Error | null = null;
  try {
    const task = await withTransaction(async (tx) => {
      const created = await createTask(
        auth,
        {
          title: payload.title.trim(),
          description: payload.description,
          dueAt: payload.dueAt ? new Date(payload.dueAt) : undefined,
          estimateMinutes: payload.estimateMinutes,
          links: payload.links,
        },
        tx,
      );
      return created;
    });
    taskId = task.id;
  } catch (error) {
    // createTask refuses on nothing user-supplied except malformed input; a
    // validation throw is a refusal. Anything else may have committed and
    // lost its reply, so it settles UNKNOWN rather than failed.
    if (error instanceof Error && /invalid|violates|malformed/i.test(error.message)) {
      refused = error;
    } else {
      ambiguous = error instanceof Error ? error : new Error("Unknown task failure.");
    }
  }

  await withTransaction(async (tx) => {
    if (taskId) {
      await settleAttempt(tx, { attemptId, outcome: "succeeded", providerObjectId: taskId });
      return;
    }
    if (refused) {
      await settleAttempt(tx, { attemptId, outcome: "failed", errorCode: "command_refused" });
      return;
    }
    await settleAttempt(tx, {
      attemptId,
      outcome: "unknown",
      errorCode: "task_outcome_unknown",
      responseSummary: { message: ambiguous?.message ?? "The command did not answer." },
    });
  });

  if (refused) throw refused;
  if (taskId) return { status: "executed", taskId };
  return { status: "unknown", reconciliationId: attemptId };
}

/** One-tap approve: records the decision, then runs the approved revision. Safe to call again after a crash. */
export async function approveTaskProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<TaskOutcome> {
  try {
    await decideProposal(auth, {
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      decision: "approved",
      idempotencyKey: `tasks-decide:${input.proposalId}`,
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
  return execute(auth, input.proposalId, input.revisionId, parsePayload(revision.payload));
}
