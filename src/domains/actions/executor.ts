import { and, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { agentRuns } from "@/domains/agents/schema";
import { LIMITS } from "@/domains/integrations/capabilities";
import {
  GmailSendAmbiguousError,
  GmailSendRejectedError,
  sendGmailMessage,
} from "@/domains/integrations/gmail/send";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { withTransaction } from "@/lib/db-transaction";
import {
  AttemptAlreadyClaimedError,
  claimAttempt,
  findClaimedAttempt,
  settleAttempt,
} from "./attempts";
import { StaleRevisionError } from "./commands";
import { actionAttempts, actionProposals, actionRevisions, actionReviews } from "./schema";

/*
 * The approved-effect executor: the only code in Polymath allowed to cause an
 * external effect. Every other path either reads, proposes, or records.
 *
 * The order below is the safety story, not a preference:
 *  - authority is re-read, never trusted from the proposal row (a cancelled run
 *    or a revoked account has to bite at execution time, not at proposal time);
 *  - the claim is written as UNKNOWN before the provider is touched, so a crash
 *    between the two leaves evidence and blocks a blind second send;
 *  - the provider call sits between two transactions, never inside one, so a
 *    slow send cannot hold a connection or roll back an audit row it earned;
 *  - ambiguity is UNKNOWN, never `failed`: a timeout says nothing about whether
 *    the mail left, and a retry on a guess is a duplicate send.
 *
 * The proposal stays `approved`. The attempt carries the outcome; marking the
 * proposal `sent` would erase the distinction between "a human approved this"
 * and "the provider accepted it".
 */

export class SendNotAllowedError extends Error {
  readonly code = "send_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "SendNotAllowedError";
  }
}

export class EffectBudgetExceededError extends Error {
  readonly code = "effect_budget_exceeded";
  constructor(readonly limit: number) {
    super(`This run has already produced ${limit} external effects.`);
    this.name = "EffectBudgetExceededError";
  }
}

export class EffectNotSupportedError extends Error {
  readonly code = "effect_not_supported";
  constructor(readonly capability: string) {
    super(`No executor exists for ${capability}.`);
    this.name = "EffectNotSupportedError";
  }
}

export type EffectOutcome =
  | { status: "sent"; providerId: string; at: string }
  | { status: "failed"; reason: string; retryable: boolean }
  | { status: "unknown"; reconciliationId: string };

/*
 * One literal, keyed by capability. A default branch that guessed at an
 * executor would turn a new capability string into an unhandled send, so an
 * unknown capability throws before anything is claimed.
 */
const EXECUTORS = {
  "gmail.send": {
    provider: "gmail",
    parse: z.object({
      to: z.string().min(1),
      subject: z.string(),
      body: z.string(),
      inReplyTo: z.string().nullish(),
    }),
  },
} as const;

type Capability = keyof typeof EXECUTORS;

function executorFor(capability: string) {
  if (!Object.prototype.hasOwnProperty.call(EXECUTORS, capability)) {
    throw new EffectNotSupportedError(capability);
  }
  return EXECUTORS[capability as Capability];
}

/**
 * Whether an approval of this capability is meant to run here. The reviews
 * queue approves every proposal, including the ones with a local executor
 * (calendar), so the caller asks before calling rather than catching a refusal.
 */
export function supportsEffect(capability: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXECUTORS, capability);
}

export const NON_TERMINAL_RUN_STATES = new Set(["queued", "running", "waiting_input", "waiting_approval"]);

type Prepared = {
  capability: Capability;
  provider: string;
  proposalId: string;
  revisionId: string;
  payload: z.infer<(typeof EXECUTORS)["gmail.send"]["parse"]>;
  accountAlias: string | null;
  runId: string | null;
  connectedAccountId: string;
};

/** The outcome a prior attempt already settled on, in the executor's vocabulary. */
function outcomeOf(attempt: typeof actionAttempts.$inferSelect): EffectOutcome | null {
  if (attempt.status === "succeeded" && attempt.providerObjectId) {
    return { status: "sent", providerId: attempt.providerObjectId, at: attempt.endedAt?.toISOString() ?? new Date().toISOString() };
  }
  if (attempt.status === "unknown") {
    return { status: "unknown", reconciliationId: attempt.id };
  }
  if (attempt.status === "failed") {
    // A failed attempt was refused before dispatch; repeating it is a new
    // intent, not this executor's call to make.
    return { status: "failed", reason: attempt.errorCode ?? "The provider refused the effect.", retryable: false };
  }
  return null;
}

type Checked = Omit<Prepared, "connectedAccountId">;

/** Steps 1–4: every check that must pass before an intent key is claimed. */
async function prepare(auth: AuthContext, proposalId: string): Promise<Prepared> {
  const checked: Checked = await withTransaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(actionProposals)
      .where(and(eq(actionProposals.workspaceId, auth.workspaceId), eq(actionProposals.id, proposalId)))
      .limit(1);
    if (!proposal) throw new SendNotAllowedError("That proposal does not exist in this workspace.");

    // Resolved before any other read so an unroutable capability fails without
    // touching proposal state.
    const executor = executorFor(proposal.capability);

    const [revision] = await tx
      .select({ id: actionRevisions.id, payload: actionRevisions.payload })
      .from(actionRevisions)
      .where(
        and(eq(actionRevisions.workspaceId, auth.workspaceId), eq(actionRevisions.proposalId, proposal.id)),
      )
      .orderBy(desc(actionRevisions.revisionNumber))
      .limit(1);
    const [review] = await tx
      .select({ decision: actionReviews.decision, revisionId: actionReviews.revisionId })
      .from(actionReviews)
      .where(
        and(eq(actionReviews.workspaceId, auth.workspaceId), eq(actionReviews.proposalId, proposal.id)),
      )
      .orderBy(desc(actionReviews.createdAt))
      .limit(1);

    // The approval binds to an exact revision. A newer revision means the owner
    // inspected a payload that is no longer the one that would be sent.
    if (
      proposal.status !== "approved" ||
      !revision ||
      !review ||
      review.decision !== "approved" ||
      review.revisionId !== revision.id
    ) {
      throw new StaleRevisionError();
    }
    if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
      throw new SendNotAllowedError("This proposal expired before it was executed.");
    }

    if (proposal.runId) {
      const [run] = await tx
        .select({ state: agentRuns.state, policySnapshot: agentRuns.policySnapshot })
        .from(agentRuns)
        .where(and(eq(agentRuns.workspaceId, auth.workspaceId), eq(agentRuns.id, proposal.runId)))
        .limit(1);
      if (!run || !NON_TERMINAL_RUN_STATES.has(run.state)) {
        throw new SendNotAllowedError("The run that proposed this effect is no longer active.");
      }
      const allowed = (run.policySnapshot as { allowedTools?: unknown } | null)?.allowedTools;
      if (!Array.isArray(allowed) || !allowed.includes(proposal.capability)) {
        throw new SendNotAllowedError(`The run's policy snapshot does not include ${proposal.capability}.`);
      }

      // The run's effect budget. This proposal's own attempts are excluded so a
      // replay returns its settled outcome instead of being refused by a budget
      // the replay already spent; a fresh effect has none, so nothing changes.
      const [prior] = await tx
        .select({ total: count() })
        .from(actionAttempts)
        .innerJoin(actionProposals, eq(actionProposals.id, actionAttempts.proposalId))
        .where(
          and(
            eq(actionAttempts.workspaceId, auth.workspaceId),
            eq(actionProposals.runId, proposal.runId),
            sqlNotThisProposal(proposal.id),
          ),
        );
      if (Number(prior?.total ?? 0) >= LIMITS.effectsPerRun) {
        throw new EffectBudgetExceededError(LIMITS.effectsPerRun);
      }
    }

    const parsed = executor.parse.safeParse(revision.payload);
    if (!parsed.success) throw new SendNotAllowedError("The approved payload is not a valid send.");

    return {
      capability: proposal.capability as Capability,
      provider: executor.provider,
      proposalId: proposal.id,
      revisionId: revision.id,
      payload: parsed.data,
      accountAlias: proposal.accountAlias,
      runId: proposal.runId,
    };
  });

  // Account resolution runs its own reads; it is not part of the check
  // transaction because nothing it returns is written.
  const account = await resolveConnectedAccount(auth, checked.provider, checked.accountAlias ?? undefined);
  if (!account.ok) throw new SendNotAllowedError(account.message);

  return { ...checked, connectedAccountId: account.connectedAccountId };
}

function sqlNotThisProposal(proposalId: string) {
  return ne(actionProposals.id, proposalId);
}

async function claim(auth: AuthContext, prepared: Prepared): Promise<{ attemptId: string } | { prior: EffectOutcome }> {
  const idempotencyKey = `exec:${prepared.proposalId}`;

  // A settled or unresolved attempt for this proposal is the truth, whoever
  // wrote it: the unique intent key is not the only way a crash can leave a
  // row behind (an earlier executor version, a manual repair).
  const existing = await withTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(actionAttempts)
      .where(
        and(
          eq(actionAttempts.workspaceId, auth.workspaceId),
          eq(actionAttempts.proposalId, prepared.proposalId),
        ),
      )
      .orderBy(desc(actionAttempts.attemptNumber))
      .limit(1);
    return rows[0] ?? null;
  });
  if (existing) {
    const prior = outcomeOf(existing);
    if (prior) return { prior };
  }

  try {
    const claimed = await withTransaction(async (tx) => {
      const [latest] = await tx
        .select({ attemptNumber: actionAttempts.attemptNumber })
        .from(actionAttempts)
        .where(
          and(
            eq(actionAttempts.workspaceId, auth.workspaceId),
            eq(actionAttempts.proposalId, prepared.proposalId),
          ),
        )
        .orderBy(desc(actionAttempts.attemptNumber))
        .limit(1);
      return claimAttempt(tx, {
        workspaceId: auth.workspaceId,
        proposalId: prepared.proposalId,
        revisionId: prepared.revisionId,
        idempotencyKey,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
      });
    });
    return { attemptId: claimed.attemptId };
  } catch (error) {
    if (!(error instanceof AttemptAlreadyClaimedError)) throw error;
    const winner = await withTransaction((tx) => findClaimedAttempt(tx, auth.workspaceId, idempotencyKey));
    const prior = winner ? outcomeOf(winner) : null;
    // A claim that vanished mid-race settles nothing; the caller must not send.
    return {
      prior: prior ?? { status: "unknown", reconciliationId: winner?.id ?? prepared.proposalId },
    };
  }
}

/*
 * The one effect. Exported so the reviews action can call it after an approval
 * and the tests can call it directly; nothing else in the app may.
 */
export async function executeApprovedEffect(
  auth: AuthContext,
  input: { proposalId: string },
): Promise<EffectOutcome> {
  const prepared = await prepare(auth, input.proposalId);

  const claimed = await claim(auth, prepared);
  if ("prior" in claimed) return claimed.prior;
  const { attemptId } = claimed;

  // Outside every transaction: the send is the slow, uncertain part, and a
  // rollback after it landed would be a lie about what happened.
  let outcome: { providerObjectId: string; threadId: string | null } | null = null;
  let rejected: GmailSendRejectedError | null = null;
  let ambiguous: GmailSendAmbiguousError | null = null;
  try {
    outcome = await sendGmailMessage({
      connectedAccountId: prepared.connectedAccountId,
      to: prepared.payload.to,
      subject: prepared.payload.subject,
      body: prepared.payload.body,
      inReplyTo: prepared.payload.inReplyTo ?? null,
      attemptId,
    });
  } catch (error) {
    if (error instanceof GmailSendRejectedError) rejected = error;
    else if (error instanceof GmailSendAmbiguousError) ambiguous = error;
    // Anything else is a programming error, but it is also an unanswered send:
    // treating it as ambiguous is the only classification that cannot duplicate.
    else ambiguous = new GmailSendAmbiguousError(error instanceof Error ? error.message : "Unknown send failure.");
  }

  return withTransaction(async (tx) => {
    if (outcome) {
      await settleAttempt(tx, {
        attemptId,
        outcome: "succeeded",
        providerObjectId: outcome.providerObjectId,
        responseSummary: { threadId: outcome.threadId },
      });
      await recordAudit(
        auth,
        {
          action: "actions.effect_sent",
          subjectType: "action_proposal",
          subjectId: prepared.proposalId,
          summary: `Sent ${prepared.capability} (${prepared.payload.to})`,
          metadata: { attemptId, providerObjectId: outcome.providerObjectId, revisionId: prepared.revisionId, runId: prepared.runId },
        },
        tx,
      );
      return {
        status: "sent" as const,
        providerId: outcome.providerObjectId,
        at: new Date().toISOString(),
      };
    }

    if (rejected) {
      await settleAttempt(tx, {
        attemptId,
        outcome: "failed",
        errorCode: `provider_rejected_${rejected.status}`,
      });
      await recordAudit(
        auth,
        {
          action: "actions.effect_failed",
          subjectType: "action_proposal",
          subjectId: prepared.proposalId,
          summary: `The provider refused ${prepared.capability} (${rejected.status})`,
          metadata: { attemptId, status: rejected.status, revisionId: prepared.revisionId },
        },
        tx,
      );
      // A 4xx is proof the provider refused before dispatch; nothing landed.
      return { status: "failed" as const, reason: rejected.message, retryable: false };
    }

    await settleAttempt(tx, {
      attemptId,
      outcome: "unknown",
      errorCode: "send_outcome_unknown",
      responseSummary: { message: ambiguous?.message ?? "The provider did not answer." },
    });
    await recordAudit(
      auth,
      {
        action: "actions.effect_unknown",
        subjectType: "action_proposal",
        subjectId: prepared.proposalId,
        summary: `${prepared.capability} outcome unknown; reconcile before any repeat`,
        metadata: { attemptId, revisionId: prepared.revisionId },
      },
      tx,
    );
    return { status: "unknown" as const, reconciliationId: attemptId };
  });
}
