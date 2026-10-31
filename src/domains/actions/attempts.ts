import { and, eq } from "drizzle-orm";
import { isUniqueViolation } from "@/lib/pg-errors";
import type { TxDrizzle } from "@/lib/db-transaction";
import { actionAttempts } from "./schema";

/*
 * The attempt lifecycle, shared by every executor. An attempt is written as
 * `unknown` BEFORE the provider call and settled after it, in the same shape
 * the correspondence executor uses: a crash between the two leaves a row that
 * blocks a second claim instead of inviting a second send.
 *
 * The claim is one INSERT. `(workspace_id, idempotency_key)` is unique, so two
 * executors racing on the same intent cannot both claim: one inserts, the other
 * gets a 23505 and must return the winner's outcome rather than send again.
 */

export class AttemptAlreadyClaimedError extends Error {
  readonly code = "attempt_already_claimed";
  constructor(readonly idempotencyKey: string) {
    super("This effect has already been claimed.");
    this.name = "AttemptAlreadyClaimedError";
  }
}

export async function claimAttempt(
  tx: TxDrizzle,
  input: {
    workspaceId: string;
    proposalId: string;
    revisionId: string;
    idempotencyKey: string;
    attemptNumber: number;
  },
): Promise<{ attemptId: string }> {
  try {
    const [row] = await tx
      .insert(actionAttempts)
      .values({
        workspaceId: input.workspaceId,
        proposalId: input.proposalId,
        revisionId: input.revisionId,
        idempotencyKey: input.idempotencyKey,
        attemptNumber: input.attemptNumber,
        status: "unknown",
        reconciliation: "pending",
      })
      .returning({ id: actionAttempts.id });
    return { attemptId: row.id };
  } catch (error) {
    if (isUniqueViolation(error)) throw new AttemptAlreadyClaimedError(input.idempotencyKey);
    throw error;
  }
}

export async function settleAttempt(
  tx: TxDrizzle,
  input: {
    attemptId: string;
    outcome: "succeeded" | "failed" | "unknown";
    providerObjectId?: string | null;
    errorCode?: string | null;
    responseSummary?: unknown;
  },
): Promise<void> {
  await tx
    .update(actionAttempts)
    .set({
      status: input.outcome,
      // Unknown is not settled: the reconciliation sweep owns it. Succeeded and
      // failed are terminal and need no observation.
      reconciliation: input.outcome === "unknown" ? "pending" : "not_needed",
      providerObjectId: input.providerObjectId ?? null,
      errorCode: input.errorCode ?? null,
      responseSummary: (input.responseSummary ?? null) as Record<string, unknown> | null,
      endedAt: input.outcome === "unknown" ? null : new Date(),
    })
    .where(eq(actionAttempts.id, input.attemptId));
}

/** The attempt a claim lost to, by intent key. Null only if it vanished mid-race. */
export async function findClaimedAttempt(
  tx: TxDrizzle,
  workspaceId: string,
  idempotencyKey: string,
) {
  const [row] = await tx
    .select()
    .from(actionAttempts)
    .where(
      and(eq(actionAttempts.workspaceId, workspaceId), eq(actionAttempts.idempotencyKey, idempotencyKey)),
    )
    .limit(1);
  return row ?? null;
}
