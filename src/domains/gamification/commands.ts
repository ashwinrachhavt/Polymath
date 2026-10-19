import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { rewardDefinitions, rewardLedger } from "./schema";

/*
 * Reward definition management and the ledger's single write path
 * (ASH-137 A10).
 *
 * awardReward is the only way a ledger row comes to exist. The idempotency
 * key contract is the whole point: the key names the event that earned the
 * reward ("focus_session:<id>" and so on), the unique index makes a replay a
 * conflict instead of a double award, and the row is append-only - a revoked
 * reward is a compensating negative entry, never a delete.
 *
 * Nothing in the product calls awardReward yet: the earning rules wait on the
 * owner's ASH-135 section 7 decisions (the Quartz rule, shard conversion).
 * Tests exercise it so the contract is proven before the first rule lands.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

function isUniqueViolation(cause: unknown): boolean {
  return (cause as { cause?: { code?: string } })?.cause?.code === "23505";
}

export type RewardDefinitionInput = {
  key: string;
  kind: "points" | "streak_day" | "badge" | "collectible";
  label: string;
  description?: string | null;
  points?: number;
  threshold?: number;
  accessibilityLabel?: string | null;
};

export async function createRewardDefinition(auth: AuthContext, input: RewardDefinitionInput) {
  try {
    return await withTransaction(async (tx) => {
      const [definition] = await tx
        .insert(rewardDefinitions)
        .values({
          workspaceId: auth.workspaceId,
          key: input.key,
          kind: input.kind,
          label: input.label,
          description: input.description ?? null,
          points: input.points ?? 0,
          threshold: input.threshold ?? 1,
          accessibilityLabel: input.accessibilityLabel ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "reward_definition.created", subjectType: "reward_definition", subjectId: definition.id, summary: `Reward defined: ${definition.key}` },
        tx,
      );
      return definition;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError(`A reward definition with the key "${input.key}" already exists.`);
    }
    throw cause;
  }
}

export async function updateRewardDefinition(
  auth: AuthContext,
  input: RewardDefinitionInput & { expectedVersion: number; active?: boolean },
) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(rewardDefinitions)
      .set({
        kind: input.kind,
        label: input.label,
        description: input.description ?? null,
        points: input.points ?? 0,
        threshold: input.threshold ?? 1,
        accessibilityLabel: input.accessibilityLabel ?? null,
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: sql`${rewardDefinitions.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(rewardDefinitions.workspaceId, auth.workspaceId),
          eq(rewardDefinitions.key, input.key),
          eq(rewardDefinitions.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The reward definition changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "reward_definition.updated", subjectType: "reward_definition", subjectId: updated.id, summary: `Reward updated: ${updated.key}` },
      tx,
    );
    return updated;
  });
}

/**
 * The ledger's only write path. Replaying the same idempotency key is a
 * ConflictError, not a second reward. Not wired to any product surface until
 * the owner decides the earning rules (ASH-135 section 7).
 */
export async function awardReward(
  auth: AuthContext,
  input: {
    definitionKey: string;
    reason: "outcome_completed" | "focus_completed" | "task_completed" | "review_decided" | "learning_reviewed" | "weekly_review" | "adjustment";
    idempotencyKey: string;
    subjectType?: string | null;
    subjectId?: string | null;
  },
) {
  try {
    return await withTransaction(async (tx) => {
      const [definition] = await tx
        .select()
        .from(rewardDefinitions)
        .where(and(eq(rewardDefinitions.workspaceId, auth.workspaceId), eq(rewardDefinitions.key, input.definitionKey)))
        .limit(1);
      if (!definition) throw new ConflictError(`No active reward definition named "${input.definitionKey}".`);
      if (!definition.active) throw new ConflictError(`The reward "${input.definitionKey}" is disabled.`);

      const [entry] = await tx
        .insert(rewardLedger)
        .values({
          workspaceId: auth.workspaceId,
          rewardDefinitionId: definition.id,
          userId: auth.userId,
          reason: input.reason,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          points: definition.points,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "reward.awarded", subjectType: "reward_ledger", subjectId: entry.id, summary: `Reward earned: ${definition.key} (${input.reason})` },
        tx,
      );
      return entry;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("This reward was already recorded for that event.");
    }
    throw cause;
  }
}
