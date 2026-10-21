import { and, asc, eq } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { workspaceOwnerAuth } from "@/domains/audit/outbox-handlers";
import { messageIdMarker } from "@/domains/integrations/gmail/send";
import { searchGmailMessages } from "@/domains/integrations/gmail/reads";
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

type PendingAttempt = {
  id: string;
  workspaceId: string;
  proposalId: string;
  startedAt: Date;
  capability: string;
  accountAlias: string | null;
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

  // Reconciliation only knows how to ask Gmail. Another capability's UNKNOWN
  // needs its own reader before this sweep can truthfully settle it.
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
    return settle(
      auth,
      attempt,
      {
        outcome: "succeeded",
        providerObjectId: hit.id,
        observedState: "sent",
        detail: { marker, threadId: hit.threadId },
      },
    );
  }

  // Not found. Inside the index lag that is not evidence of absence, so the
  // row keeps its UNKNOWN status and the next pass asks again.
  if (now.getTime() - attempt.startedAt.getTime() < RECONCILIATION_LAG_MS) return false;

  return settle(auth, attempt, {
    outcome: "failed",
    errorCode: "reconciled_absent",
    observedState: "absent",
    detail: { marker, lagMs: RECONCILIATION_LAG_MS },
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
    observedState: "sent" | "absent";
    detail: Record<string, unknown>;
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
      provider: "gmail",
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
        summary:
          outcome.observedState === "sent"
            ? `Reconciled as sent (${outcome.providerObjectId})`
            : "Reconciled as failed: the provider shows no matching message",
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
