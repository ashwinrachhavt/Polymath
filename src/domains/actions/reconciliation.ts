import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { workspaceOwnerAuth } from "@/domains/audit/outbox-handlers";
import { messageIdMarker } from "@/domains/integrations/gmail/send";
import { searchGmailMessages } from "@/domains/integrations/gmail/reads";
import { canvaImportFixtureEnabled, canvaImportLiveEnabled, getCanvaImportJob } from "@/domains/integrations/canva/import";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import type { Transport } from "@/domains/integrations/transport";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { settleAttempt } from "./attempts";
import { actionAttempts, actionProposals, providerObservations } from "./schema";

/*
 * The reconciliation sweep: the only thing allowed to close an UNKNOWN attempt.
 *
 * An UNKNOWN means the provider was asked to do something and Polymath never
 * learned the answer. The sweep asks the provider a *read* question — "is the
 * marker there?" — and settles on the answer. It never sends again, because a
 * second send is exactly the failure the UNKNOWN state exists to prevent.
 *
 * Absence is not proof. Gmail's search index lags a sent message by minutes, so
 * "not found" only means "not found *yet*" until the attempt is older than
 * LAG_MS. Inside that window the row is left alone on purpose: settling
 * `failed` would invite a retry of a message that may already be in flight.
 *
 * A transport error proves nothing either. The row is left untouched so the
 * next pass can ask again; there is no guess big enough to justify settling.
 */

/** How long Gmail's index may lag a delivered message. Absence before this is not evidence. */
export const RECONCILIATION_LAG_MS = 10 * 60_000;

/*
 * How long the sweep keeps asking Canva about one import job. Canva jobs
 * finish in minutes; a day of `in_progress` is a stuck job, and the bound is
 * what keeps one stuck job from being polled forever (the get endpoint is
 * rate-limited per user). Past the budget the row stays UNKNOWN for a human
 * and the sweep stops asking - bounded, never settled on a guess.
 */
export const CANVA_IMPORT_POLL_BUDGET_MS = 24 * 60 * 60_000;

/*
 * The minimum gap between two polls of the same import job. The 24h budget
 * bounds TIME, not CALLS: without this interval, every sweep invocation
 * (overlapping cron ticks, a worker plus a cron) would read the provider
 * again, so the call count would float with how the sweep is triggered. The
 * poll slot is claimed atomically on the attempt row (below), so concurrent
 * sweeps cannot multiply reads, and the per-job maximum is fixed:
 * 1 create + at most 24h / CANVA_IMPORT_MIN_POLL_INTERVAL_MS reads.
 */
export const CANVA_IMPORT_MIN_POLL_INTERVAL_MS = 5 * 60_000;

type PendingAttempt = {
  id: string;
  workspaceId: string;
  proposalId: string;
  startedAt: Date;
  capability: string;
  accountAlias: string | null;
  responseSummary: unknown;
};

export type ReconciliationResult = { reconciled: number };

/**
 * One sweep pass. Oldest first so a backlog drains in the order it accumulated;
 * `limit` bounds the provider calls one cron tick may make.
 *
 * Runs outside any request and spans workspaces, like the outbox dispatcher, so
 * it takes no AuthContext. Audit rows still need an actor: the workspace's
 * earliest active owner stands in, marked `system`.
 */
export async function reconcileUnknownAttempts(input: {
  transport: Transport;
  now?: Date;
  limit?: number;
}): Promise<ReconciliationResult> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 20;

  const pending = await db
    .select({
      id: actionAttempts.id,
      workspaceId: actionAttempts.workspaceId,
      proposalId: actionAttempts.proposalId,
      startedAt: actionAttempts.startedAt,
      capability: actionProposals.capability,
      accountAlias: actionProposals.accountAlias,
      responseSummary: actionAttempts.responseSummary,
    })
    .from(actionAttempts)
    .innerJoin(actionProposals, eq(actionProposals.id, actionAttempts.proposalId))
    // `succeeded` is never selected: its reconciliation is `not_needed`, and
    // the status predicate is the second fence in case a row was hand-edited.
    .where(and(eq(actionAttempts.status, "unknown"), eq(actionAttempts.reconciliation, "pending")))
    .orderBy(asc(actionAttempts.startedAt))
    .limit(limit);

  const authByWorkspace = new Map<string, AuthContext | null>();
  let reconciled = 0;

  for (const attempt of pending) {
    let auth = authByWorkspace.get(attempt.workspaceId);
    if (auth === undefined) {
      auth = await workspaceOwnerAuth(attempt.workspaceId);
      authByWorkspace.set(attempt.workspaceId, auth);
    }
    // No actor means no audit row, and no audit row means no settle.
    if (!auth) continue;

    try {
      if (await reconcileOne({ attempt, auth, transport: input.transport, now })) reconciled += 1;
    } catch {
      // A malformed provider payload or a transient database error settles
      // nothing: the attempt stays pending and the next pass tries again.
      // Swallowing here is the safe failure - the alternative is a guess.
    }
  }

  return { reconciled };
}

async function reconcileOne(input: {
  attempt: PendingAttempt;
  auth: AuthContext;
  transport: Transport;
  now: Date;
}): Promise<boolean> {
  const { attempt, auth, transport, now } = input;

  // Calendar is genuinely terminal here. Its commands are replay-safe, but an
  // event row carries no marker tying it back to the attempt that made it, so
  // the sweep cannot tell "landed" from "never ran" without guessing. It stays
  // UNKNOWN for a person to inspect rather than being settled on a coin flip.
  //
  // Reconciliation only knows how to ask Gmail and Canva. Another capability's
  // UNKNOWN needs its own reader before this sweep can truthfully settle it.
  if (attempt.capability === "canva.design.import") {
    return reconcileCanvaImport({ attempt, auth, transport: input.transport });
  }
  if (attempt.capability !== "gmail.send") return false;

  const account = await resolveConnectedAccount(auth, "gmail", attempt.accountAlias ?? undefined);
  // A revoked/expired account cannot be searched through; that is not proof
  // the send failed. Leave the row for a human, not for a guess.
  if (!account.ok) return false;

  const marker = messageIdMarker(attempt.id);
  const search = await searchGmailMessages(transport, {
    connectedAccountId: account.connectedAccountId,
    query: `rfc822msgid:${marker}`,
    limit: 1,
  });
  // Transport error: the provider did not answer, which proves nothing.
  if (!search.ok) return false;

  const hit = search.messages[0];
  if (hit) {
    return settle(auth, attempt, {
      outcome: "succeeded",
      providerObjectId: hit.id,
      provider: "gmail",
      observedState: "sent",
      detail: { marker, threadId: hit.threadId },
      summary: `Reconciled as sent (${hit.id})`,
    });
  }

  // Not found. Inside the index lag that is not evidence of absence, so the
  // row keeps its UNKNOWN status and the next pass asks again.
  if (now.getTime() - attempt.startedAt.getTime() < RECONCILIATION_LAG_MS) return false;

  return settle(auth, attempt, {
    outcome: "failed",
    errorCode: "reconciled_absent",
    provider: "gmail",
    observedState: "absent",
    detail: { marker, lagMs: RECONCILIATION_LAG_MS },
    summary: "Reconciled as failed: the provider shows no matching message",
  });
}

/**
 * One settle: the shared attempt settler, the observation that justified it,
 * and the audit row, in one transaction. `settleAttempt` marks terminal
 * outcomes `not_needed`; the sweep re-marks them `resolved` so the two states
 * stay distinguishable - "no reconciliation was needed" is not the same claim
 * as "reconciliation looked and answered".
 */
async function settle(
  auth: AuthContext,
  attempt: PendingAttempt,
  outcome: {
    outcome: "succeeded" | "failed";
    errorCode?: string;
    providerObjectId?: string;
    provider: string;
    observedState: string;
    detail: Record<string, unknown>;
    /** The audit line a person reads; the sweep never invents one. */
    summary: string;
  },
): Promise<boolean> {
  return withTransaction(async (tx) => {
    // Fence the settle on the row still being unresolved. The sweep can run
    // concurrently (two cron ticks, a worker and a cron), and the loser must
    // write no observation and no second audit row.
    const [claimed] = await tx
      .update(actionAttempts)
      .set({ reconciliation: "resolved" })
      .where(
        and(
          eq(actionAttempts.id, attempt.id),
          eq(actionAttempts.status, "unknown"),
          eq(actionAttempts.reconciliation, "pending"),
        ),
      )
      .returning({ id: actionAttempts.id });
    if (!claimed) return false;

    await settleAttempt(tx, {
      attemptId: attempt.id,
      outcome: outcome.outcome,
      providerObjectId: outcome.providerObjectId ?? null,
      errorCode: outcome.errorCode ?? null,
      responseSummary: { reconciled: true, observedState: outcome.observedState },
    });
    // settleAttempt marks a terminal outcome `not_needed`; reconciliation did
    // look and answer, so the claim above is the truth.
    await tx
      .update(actionAttempts)
      .set({ reconciliation: "resolved" })
      .where(eq(actionAttempts.id, attempt.id));
    await tx.insert(providerObservations).values({
      workspaceId: attempt.workspaceId,
      attemptId: attempt.id,
      proposalId: attempt.proposalId,
      provider: outcome.provider,
      providerObjectId: outcome.providerObjectId ?? null,
      observedState: outcome.observedState,
      detail: outcome.detail,
    });
    await recordAudit(
      auth,
      {
        action: "actions.effect_reconciled",
        subjectType: "action_proposal",
        subjectId: attempt.proposalId,
        summary: outcome.summary,
        metadata: {
          attemptId: attempt.id,
          observedState: outcome.observedState,
          providerObjectId: outcome.providerObjectId ?? null,
        },
        actorKind: "system",
      },
      tx,
    );
    return true;
  });
}


/*
 * The Canva import reader. Two questions, both answered by one GET:
 *  - no job id on the attempt means the creation response was lost. Canva
 *    exposes NO list-imports endpoint (design-imports reference, fetched
 *    2026-10-25: create, create-by-url, get, get-url-job only), so there is
 *    no honest read that could find the job again - the attempt stays UNKNOWN
 *    for a human, exactly like calendar, and never re-fires;
 *  - with a job id, the terminal answer is the job's own status. `in_progress`
 *    is an observed state, not absence: the row is left for the next pass, and
 *    no lag window turns a still-running job into a failure. A job Canva never
 *    finishes stays for a human rather than being settled on a guess.
 */
async function reconcileCanvaImport(input: {
  attempt: PendingAttempt;
  auth: AuthContext;
  transport: Transport;
}): Promise<boolean> {
  const { attempt, auth, transport } = input;
  const summary = (attempt.responseSummary ?? null) as { jobId?: unknown } | null;
  const jobId = typeof summary?.jobId === "string" && summary.jobId.length > 0 ? summary.jobId : null;
  if (!jobId) return false;

  // Bounded polling: past the budget the sweep stops asking entirely. The
  // attempt stays UNKNOWN for a human; it is never settled on a guess.
  if (Date.now() - attempt.startedAt.getTime() > CANVA_IMPORT_POLL_BUDGET_MS) return false;

  // A disabled live import is skipped before claiming anything: the sweep
  // stays write-free and read-free for Canva while the boundary is off. The
  // fixture is exempt - it answers without a transport by construction.
  if (!canvaImportFixtureEnabled() && !canvaImportLiveEnabled()) return false;

  const account = await resolveConnectedAccount(auth, "canva", attempt.accountAlias ?? undefined);
  // A revoked/expired account cannot be read through; that is not proof about
  // the job. Leave the row for a human, not for a guess.
  if (!account.ok) return false;

  /*
   * Claim this job's poll slot atomically. The conditional UPDATE is the
   * fence: a concurrent sweep (two cron ticks, a worker and a cron) updates
   * zero rows and skips, so one job gets at most one provider read per
   * CANVA_IMPORT_MIN_POLL_INTERVAL_MS no matter how the sweep is triggered.
   * The slot lives in responseSummary - no migration, and the terminal
   * settle overwrites the whole summary anyway. A crash between claim and
   * read costs one interval, then self-heals.
   */
  const nowMs = Date.now();
  const [slot] = await db
    .update(actionAttempts)
    .set({
      responseSummary: sql`jsonb_set(coalesce(response_summary, '{}'::jsonb), '{polledAt}', to_jsonb(${nowMs}::bigint))`,
    })
    .where(
      and(
        eq(actionAttempts.id, attempt.id),
        eq(actionAttempts.status, "unknown"),
        eq(actionAttempts.reconciliation, "pending"),
        sql`coalesce((response_summary->>'polledAt')::bigint, 0) <= ${nowMs - CANVA_IMPORT_MIN_POLL_INTERVAL_MS}`,
      ),
    )
    .returning({ id: actionAttempts.id });
  if (!slot) return false;

  const read = await getCanvaImportJob(transport, { connectedAccountId: account.connectedAccountId, jobId });
  // Transport error or an unreadable answer: the provider did not answer,
  // which proves nothing.
  if (!read.ok) return false;
  if (read.job.status === "in_progress") return false;

  if (read.job.status === "success") {
    return settle(auth, attempt, {
      outcome: "succeeded",
      providerObjectId: read.job.designId ?? jobId,
      provider: "canva",
      observedState: "imported",
      detail: { jobId, designId: read.job.designId, editUrl: read.job.editUrl },
      summary: `Reconciled as imported: Canva design ${read.job.designId ?? "created"} (job ${jobId})`,
    });
  }

  return settle(auth, attempt, {
    outcome: "failed",
    errorCode: "canva_import_failed",
    provider: "canva",
    observedState: "import_failed",
    detail: { jobId, canvaErrorCode: read.job.errorCode },
    summary: `Reconciled as failed: Canva reports the import job failed${read.job.errorCode ? ` (${read.job.errorCode})` : ""}`,
  });
}
