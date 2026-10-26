import { and, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { agentRuns } from "@/domains/agents/schema";
import { LIMITS } from "@/domains/integrations/capabilities";
import {
  canvaImportFixtureEnabled,
  canvaImportLiveEnabled,
  CanvaImportRejectedError,
  createCanvaImportJob,
} from "@/domains/integrations/canva/import";
import { composioWriteConfigured } from "@/domains/integrations/composio";
import { GmailSendRejectedError, sendGmailMessage } from "@/domains/integrations/gmail/send";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { designBriefSchema } from "@/domains/knowledge/design-brief";
import { designBriefDocx, designBriefDocxSha256 } from "@/domains/knowledge/design-brief-docx";
import { applyNotionProposal } from "@/domains/knowledge/notion-proposals";
import { withTransaction } from "@/lib/db-transaction";
import {
  AttemptAlreadyClaimedError,
  claimAttempt,
  findClaimedAttempt,
  settleAttempt,
} from "./attempts";
import { StaleRevisionError } from "./commands";
import { checkSenderAlias, senderAliasPolicy } from "./policy";
import { actionAttempts, actionProposals, actionRevisions, actionReviews, executionSettings } from "./schema";

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
  /*
   * `note` separates two honest UNKNOWN phases a person must tell apart:
   * "import_started" (the provider accepted the job; its terminal answer is
   * pending) from an outcome that never got an answer at all.
   */
  | { status: "unknown"; reconciliationId: string; note?: "import_started" };

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
  // ASH-283. The payload is the exact text the owner approved; the executor
  // re-checks its hash against the approved revision before writing.
  "notion.page.append": {
    provider: "notion",
    parse: z.object({
      mode: z.literal("append"),
      pageId: z.string().min(1),
      title: z.string(),
      markdown: z.string().min(1),
      contentHash: z.string().min(1),
    }),
  },
  "notion.page.create": {
    provider: "notion",
    parse: z.object({
      mode: z.literal("create"),
      parentId: z.string().min(1),
      parentType: z.enum(["page", "database"]).optional(),
      title: z.string().min(1),
      markdown: z.string().min(1),
      contentHash: z.string().min(1),
    }),
  },
  /*
   * The design-brief handoff (ADR 0009). The payload embeds the approved
   * brief plus the SHA-256 of its deterministic DOCX render: the bytes Canva
   * receives are exactly the bytes the owner approved, and a renderer change
   * refuses execution instead of substituting unapproved bytes. Execution is
   * a Canva import JOB - asynchronous - so a created job settles the attempt
   * as UNKNOWN-with-a-job-id and the reconciliation sweep polls the job to
   * its terminal state. Canva exposes no list-imports endpoint, so a lost
   * creation response stays UNKNOWN for a human and never re-fires.
   */
  "canva.design.import": {
    provider: "canva",
    parse: z.object({
      title: z.string().trim().min(1).max(255),
      brief: designBriefSchema,
      docxSha256: z.string().regex(/^[0-9a-f]{64}$/),
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

/**
 * The payload of any capability that has an executor. Each member is the shape
 * its own `parse` produced, so a branch below can narrow on `capability` alone
 * and never has to cast an unknown payload into the wrong provider's contract.
 */
type ExecutorPayload =
  | z.infer<(typeof EXECUTORS)["gmail.send"]["parse"]>
  | z.infer<(typeof EXECUTORS)["notion.page.append"]["parse"]>
  | z.infer<(typeof EXECUTORS)["notion.page.create"]["parse"]>
  | z.infer<(typeof EXECUTORS)["canva.design.import"]["parse"]>;

type Prepared = {
  capability: Capability;
  provider: string;
  proposalId: string;
  revisionId: string;
  payload: ExecutorPayload;
  accountAlias: string | null;
  runId: string | null;
  connectedAccountId: string;
};

/** The outcome a prior attempt already settled on, in the executor's vocabulary. */
export function outcomeOf(attempt: typeof actionAttempts.$inferSelect): EffectOutcome | null {
  if (attempt.status === "succeeded" && attempt.providerObjectId) {
    return { status: "sent", providerId: attempt.providerObjectId, at: attempt.endedAt?.toISOString() ?? new Date().toISOString() };
  }
  if (attempt.status === "unknown") {
    const phase = (attempt.responseSummary as { phase?: unknown } | null)?.phase;
    return {
      status: "unknown",
      reconciliationId: attempt.id,
      ...(phase === "import_in_progress" ? { note: "import_started" as const } : {}),
    };
  }
  if (attempt.status === "failed") {
    // A failed attempt was refused before dispatch; repeating it is a new
    // intent, not this executor's call to make.
    return { status: "failed", reason: attempt.errorCode ?? "The provider refused the effect.", retryable: false };
  }
  return null;
}

type AccountPin = { externalAccountId?: unknown; connectedAccountId?: unknown; resolved?: unknown };

type Checked = Omit<Prepared, "connectedAccountId"> & { accountPin: AccountPin | null };

/** Steps 1–4: every check that must pass before an intent key is claimed. */
async function prepare(auth: AuthContext, proposalId: string): Promise<Prepared> {
  const checked: Checked = await withTransaction(async (tx) => {
    // The workspace kill switch, read before anything else so a paused
    // workspace fails without touching proposal or attempt state. The column
    // existed and nothing consulted it, which made an emergency stop look
    // available when it was not.
    const [settings] = await tx
      .select({ paused: executionSettings.paused, reason: executionSettings.pausedReason })
      .from(executionSettings)
      .where(eq(executionSettings.workspaceId, auth.workspaceId))
      .limit(1);
    if (settings?.paused) {
      throw new SendNotAllowedError(
        `Execution is paused for this workspace${settings.reason ? `: ${settings.reason}` : "."}`,
      );
    }

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
      accountPin: ((revision.payload ?? {}) as { accountPin?: AccountPin }).accountPin ?? null,
    };
  });

  // Account resolution runs its own reads; it is not part of the check
  // transaction because nothing it returns is written.
  const account = await resolveConnectedAccount(auth, checked.provider, checked.accountAlias ?? undefined);
  if (!account.ok) throw new SendNotAllowedError(account.message);
  /*
   * The approval pinned the exact sender identity - the external_accounts
   * row and the provider's connected-account id - into the approved
   * revision. Send only from that identity: a reconnect swaps the
   * connected-account id in place, a default or selection change resolves
   * the alias to a different row, and an approval written before pinning
   * existed carries no pin. All three refuse; a fresh approval re-binds.
   */
  const pin = checked.accountPin;
  if (
    !pin ||
    pin.resolved === false ||
    typeof pin.externalAccountId !== "string" ||
    typeof pin.connectedAccountId !== "string"
  ) {
    throw new SendNotAllowedError("This revision was written before a sending account was bound to it. Review and approve a fresh revision.");
  }
  if (pin.externalAccountId !== account.externalAccountId || pin.connectedAccountId !== account.connectedAccountId) {
    throw new SendNotAllowedError("The sending account no longer matches the approved revision. Review and approve a fresh revision.");
  }

  // ASH-289: the sending grant is re-read at execution, not borrowed from the
  // approval. Tightening the authorized senders revokes an already-approved
  // proposal rather than grandfathering it; the pin carries the alias it was
  // approved with, and only an authorized alias may send.
  // Every pinned capability, not only gmail: the pin path applies this policy
  // when a revision is written (notion.page.* included), so skipping it here
  // would let tightening a grant leave an already-approved Notion write live.
  const pinAlias = typeof (pin as { alias?: unknown }).alias === "string" ? (pin as { alias: string }).alias : null;
  // Canva acts through a connected account; Gmail sends as a sender. The
  // semantics are the shared grant; the word a person reads is not.
  const noun = checked.provider === "canva" ? ("connected account" as const) : ("sender" as const);
  const verdict = checkSenderAlias(await senderAliasPolicy(auth.workspaceId, checked.capability), pinAlias, noun);
  if (!verdict.allowed) throw new SendNotAllowedError(verdict.reason);

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
/**
 * What one provider call produced, normalised across capabilities so the
 * settle/audit path below is written once. `label` is what the audit line names
 * as the effect's subject - the recipient for mail, the page for Notion.
 */
type Dispatched =
  | { ok: true; providerObjectId: string; label: string; summary: Record<string, unknown> }
  /*
   * An accepted ASYNC job is not a finished effect: the settle path records
   * it as UNKNOWN with the job id as the reconciliation sweep's read-back
   * pointer - the sweep, never a second create, owns the terminal answer.
   */
  | { accepted: true; jobId: string; label: string }
  | { ok: false; label: string; rejected: { status: string; message: string } | null; ambiguous: string };

/**
 * The one place a capability's effect is actually caused. Each branch owns its
 * own failure vocabulary, because "the provider refused" and "we do not know"
 * arrive differently per provider and collapsing them early is how a duplicate
 * gets sent.
 */
async function dispatch(auth: AuthContext, prepared: Prepared, attemptId: string): Promise<Dispatched> {
  switch (prepared.capability) {
    case "gmail.send": {
      const payload = prepared.payload as z.infer<(typeof EXECUTORS)["gmail.send"]["parse"]>;
      try {
        const sent = await sendGmailMessage({
          connectedAccountId: prepared.connectedAccountId,
          to: payload.to,
          subject: payload.subject,
          body: payload.body,
          inReplyTo: payload.inReplyTo ?? null,
          attemptId,
        });
        return { ok: true, providerObjectId: sent.providerObjectId, label: payload.to, summary: { threadId: sent.threadId } };
      } catch (error) {
        if (error instanceof GmailSendRejectedError) {
          return { ok: false, label: payload.to, rejected: { status: String(error.status), message: error.message }, ambiguous: "" };
        }
        // Anything else is a programming error, but it is also an unanswered
        // send: treating it as ambiguous is the only classification that cannot
        // duplicate.
        return {
          ok: false,
          label: payload.to,
          rejected: null,
          ambiguous: error instanceof Error ? error.message : "Unknown send failure.",
        };
      }
    }
    case "notion.page.append":
    case "notion.page.create": {
      const payload = prepared.payload as
        | z.infer<(typeof EXECUTORS)["notion.page.append"]["parse"]>
        | z.infer<(typeof EXECUTORS)["notion.page.create"]["parse"]>;
      const label = payload.mode === "append" ? payload.pageId : payload.title;
      const applied = await applyNotionProposal(auth, {
        proposalId: prepared.proposalId,
        accountAlias: prepared.accountAlias ?? prepared.connectedAccountId,
      });
      if (applied.status === "sent" && applied.providerId) {
        return { ok: true, providerObjectId: applied.providerId, label, summary: { url: applied.url ?? null } };
      }
      // Notion answers with a status, so a whole-page failure is a refusal to
      // act rather than an unknown: no block was written that we did not see.
      return { ok: false, label, rejected: { status: "notion", message: applied.error ?? "Notion refused the write." }, ambiguous: "" };
    }
    case "canva.design.import": {
      const payload = prepared.payload as z.infer<(typeof EXECUTORS)["canva.design.import"]["parse"]>;
      try {
        const { jobId } = await createCanvaImportJob({
          connectedAccountId: prepared.connectedAccountId,
          title: payload.title,
          docx: designBriefDocx(payload.brief),
        });
        return { accepted: true, jobId, label: payload.title };
      } catch (error) {
        if (error instanceof CanvaImportRejectedError) {
          return { ok: false, label: payload.title, rejected: { status: String(error.status), message: error.message }, ambiguous: "" };
        }
        // An unanswered job creation is ambiguous, never failed: the import
        // may exist on Canva's side, and a blind retry is a duplicate import.
        return {
          ok: false,
          label: payload.title,
          rejected: null,
          ambiguous: error instanceof Error ? error.message : "Unknown import failure.",
        };
      }
    }
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

  if (prepared.capability === "canva.design.import") {
    // Integrity before any claim: the bytes must be the bytes the owner
    // approved. A renderer change since approval refuses the run and leaves
    // no attempt behind; a fresh revision + approval re-pins the new render.
    const payload = prepared.payload as z.infer<(typeof EXECUTORS)["canva.design.import"]["parse"]>;
    if (designBriefDocxSha256(payload.brief) !== payload.docxSha256) {
      throw new SendNotAllowedError(
        "The approved brief no longer renders to the approved document. Review and approve a fresh revision.",
      );
    }
    // Dispatchability before any claim, enablement first: a generic Composio
    // key (present for Gmail in any real deployment) must never stand in for
    // the explicit Canva opt-in, and an unconfigured deployment provably
    // cannot reach the provider. Either way the honest outcome is a refusal -
    // not an UNKNOWN attempt that would block the proposal against a fix.
    if (!canvaImportFixtureEnabled()) {
      if (!canvaImportLiveEnabled()) {
        throw new SendNotAllowedError("Canva import is not enabled on this deployment; the import cannot be dispatched.");
      }
      if (!composioWriteConfigured()) {
        throw new SendNotAllowedError("Composio is not configured on this deployment yet; the import cannot be dispatched.");
      }
    }
  }

  const claimed = await claim(auth, prepared);
  if ("prior" in claimed) return claimed.prior;
  const { attemptId } = claimed;

  // Outside every transaction: the call is the slow, uncertain part, and a
  // rollback after it landed would be a lie about what happened.
  let dispatched: Dispatched;
  try {
    dispatched = await dispatch(auth, prepared, attemptId);
  } catch (error) {
    // A throw out of the provider boundary is an unanswered effect, never a
    // clean failure.
    dispatched = { ok: false, label: prepared.proposalId, rejected: null, ambiguous: error instanceof Error ? error.message : "Unknown provider failure." };
  }

  return withTransaction(async (tx) => {
    if ("accepted" in dispatched) {
      await settleAttempt(tx, {
        attemptId,
        outcome: "unknown",
        providerObjectId: dispatched.jobId,
        errorCode: "import_in_progress",
        responseSummary: { jobId: dispatched.jobId, phase: "import_in_progress", title: dispatched.label },
      });
      await recordAudit(
        auth,
        {
          action: "actions.effect_unknown",
          subjectType: "action_proposal",
          subjectId: prepared.proposalId,
          summary: `Canva import job created (${dispatched.jobId}); waiting for Canva's terminal status`,
          metadata: { attemptId, jobId: dispatched.jobId, revisionId: prepared.revisionId, runId: prepared.runId },
        },
        tx,
      );
      return { status: "unknown" as const, reconciliationId: attemptId, note: "import_started" as const };
    }

    if (dispatched.ok) {
      await settleAttempt(tx, {
        attemptId,
        outcome: "succeeded",
        providerObjectId: dispatched.providerObjectId,
        responseSummary: dispatched.summary,
      });
      await recordAudit(
        auth,
        {
          action: "actions.effect_sent",
          subjectType: "action_proposal",
          subjectId: prepared.proposalId,
          summary: `Sent ${prepared.capability} (${dispatched.label})`,
          metadata: { attemptId, providerObjectId: dispatched.providerObjectId, revisionId: prepared.revisionId, runId: prepared.runId },
        },
        tx,
      );
      return {
        status: "sent" as const,
        providerId: dispatched.providerObjectId,
        at: new Date().toISOString(),
      };
    }

    if (dispatched.rejected) {
      const rejected = dispatched.rejected;
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
      errorCode: prepared.capability === "canva.design.import" ? "import_outcome_unknown" : "send_outcome_unknown",
      responseSummary: { message: dispatched.ambiguous || "The provider did not answer." },
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
