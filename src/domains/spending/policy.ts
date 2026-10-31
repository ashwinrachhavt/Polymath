import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { isUniqueViolation } from "@/lib/pg-errors";
import { modelRateCards, spendingPolicies } from "./schema";

/*
 * Policy and rate-card mutations. There is exactly one policy row per
 * workspace (the unique index says so); the first save inserts it and every
 * later save is a version-checked update, so two open tabs cannot both think
 * they set the ceiling. Rate cards are immutable history: a price change is
 * a new row with a later effectiveFrom, never an edit, so a settled run can
 * always be priced against the card that was active when it ran.
 */

/** numeric columns come back from drizzle as strings; keep them strings. */
type Money = string;

export class ConflictError extends Error {
  readonly code = "conflict";
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

export type PolicyInput = {
  dailyCeilingUsd: Money | null;
  monthlyCeilingUsd: Money | null;
  perRunCeilingUsd: Money | null;
  onExceeded: "pause" | "fail";
};

export async function upsertSpendingPolicy(
  auth: AuthContext,
  input: PolicyInput & { expectedVersion: number | null },
) {
  return withTransaction(async (tx) => {
    if (input.expectedVersion === null) {
      // First save. A second tab racing the insert hits the workspace unique
      // index and is told to reload, not silently overwritten.
      try {
        const [created] = await tx
          .insert(spendingPolicies)
          .values({
            workspaceId: auth.workspaceId,
            dailyCeilingUsd: input.dailyCeilingUsd,
            monthlyCeilingUsd: input.monthlyCeilingUsd,
            perRunCeilingUsd: input.perRunCeilingUsd,
            onExceeded: input.onExceeded,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning();
        await recordAudit(auth, {
          action: "spending_policy.created",
          subjectType: "spending_policy",
          subjectId: created.id,
          summary: "Spending policy created",
        }, tx);
        return created;
      } catch (cause) {
        if (isUniqueViolation(cause)) {
          throw new StaleWriteError("A spending policy was saved while you worked. Reload and try again.");
        }
        throw cause;
      }
    }
    const [updated] = await tx
      .update(spendingPolicies)
      .set({
        dailyCeilingUsd: input.dailyCeilingUsd,
        monthlyCeilingUsd: input.monthlyCeilingUsd,
        perRunCeilingUsd: input.perRunCeilingUsd,
        onExceeded: input.onExceeded,
        version: sql`${spendingPolicies.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(and(eq(spendingPolicies.workspaceId, auth.workspaceId), eq(spendingPolicies.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new StaleWriteError("The spending policy changed since you loaded it. Reload and try again.");
    }
    await recordAudit(auth, {
      action: "spending_policy.updated",
      subjectType: "spending_policy",
      subjectId: updated.id,
      summary: "Spending policy updated",
    }, tx);
    return updated;
  });
}

export async function createRateCard(
  auth: AuthContext,
  input: {
    provider: string;
    model: string;
    inputPerMillion: Money;
    outputPerMillion: Money;
    /** Backfill a historical price; defaults to now. */
    effectiveFrom?: Date;
  },
) {
  try {
    return await withTransaction(async (tx) => {
      const [card] = await tx
        .insert(modelRateCards)
        .values({
          workspaceId: auth.workspaceId,
          provider: input.provider,
          model: input.model,
          inputPerMillion: input.inputPerMillion,
          outputPerMillion: input.outputPerMillion,
          ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(auth, {
        action: "rate_card.created",
        subjectType: "rate_card",
        subjectId: card.id,
        summary: `Rate card added: ${card.provider}/${card.model} in $${card.inputPerMillion} out $${card.outputPerMillion} per M tokens`,
      }, tx);
      return card;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A rate card for this provider, model and effective time already exists.");
    }
    throw cause;
  }
}
