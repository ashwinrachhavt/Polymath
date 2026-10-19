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

/*
 * The owner's earning rules (ASH-150 follow-up, decided 2026-10-18):
 *
 * QUARTZ - one per day, on the first completed task. The day boundary is the
 * workspace timezone (user_preferences); the idempotency key `quartz:<day>`
 * plus the unique index makes "first of the day" a database fact, and a
 * replayed or second completion is a silent skip, not an error. The
 * definition is created lazily with the donor's value (10 points) so the
 * rule works before anyone opens the definition form.
 *
 * SHARD - explicit claim, never auto-convert. Five recorded stones fuse into
 * one claimable shard (the donor's stonesPerShard = 5); claiming records a
 * ledger row against the lazily-created "shard" definition. The claim count
 * itself is the claimed marker, and the key `shard-claim:<n>` serializes a
 * racing double-claim into a ConflictError.
 */

export const STONES_PER_SHARD = 5;

const QUARTZ = { key: "quartz", label: "Quartz", points: 10 };
const SHARD = { key: "shard", label: "Shard", points: 0 };

type TxDrizzle = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function ensureDefinition(
  tx: TxDrizzle,
  auth: AuthContext,
  input: { key: string; kind: "points" | "collectible"; label: string; points: number; description: string },
) {
  const [definition] = await tx
    .insert(rewardDefinitions)
    .values({
      workspaceId: auth.workspaceId,
      key: input.key,
      kind: input.kind,
      label: input.label,
      description: input.description,
      points: input.points,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoNothing({ target: [rewardDefinitions.workspaceId, rewardDefinitions.key] })
    .returning();
  if (definition) return definition;
  const [existing] = await tx
    .select()
    .from(rewardDefinitions)
    .where(and(eq(rewardDefinitions.workspaceId, auth.workspaceId), eq(rewardDefinitions.key, input.key)))
    .limit(1);
  return existing;
}

/**
 * Called from task completion, inside the same transaction. Never throws for
 * game reasons: a disabled definition or an already-awarded day simply skips.
 */
export async function recordDailyQuartz(tx: TxDrizzle, auth: AuthContext, taskId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    select to_char(timezone(coalesce(
      (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId} limit 1),
      'UTC'), now()), 'YYYY-MM-DD') as day
  `);
  const day = (rows as unknown as Array<{ day: string }>)[0].day;

  const definition = await ensureDefinition(tx, auth, {
    ...QUARTZ,
    kind: "points",
    description: "First completed task of the day.",
  });
  if (!definition || !definition.active) return false;

  const [entry] = await tx
    .insert(rewardLedger)
    .values({
      workspaceId: auth.workspaceId,
      rewardDefinitionId: definition.id,
      userId: auth.userId,
      reason: "task_completed",
      subjectType: "task",
      subjectId: taskId,
      points: definition.points,
      idempotencyKey: `quartz:${day}`,
    })
    .onConflictDoNothing({ target: [rewardLedger.workspaceId, rewardLedger.idempotencyKey] })
    .returning();
  if (!entry) return false;
  await recordAudit(
    auth,
    { action: "reward.awarded", subjectType: "reward_ledger", subjectId: entry.id, summary: `Quartz earned (${day})` },
    tx,
  );
  return true;
}

/** Stones and claims, derived from the ledger at read time. */
export async function shardState(auth: AuthContext): Promise<{ stones: number; claimed: number; claimable: number }> {
  const { db } = await import("@/lib/db");
  const rows = await db.execute(sql`
    select
      count(*) filter (where d.key <> ${SHARD.key})::int as stones,
      count(*) filter (where d.key = ${SHARD.key})::int as claimed
    from reward_ledger l
    join reward_definitions d on d.id = l.reward_definition_id
    where l.workspace_id = ${auth.workspaceId}
  `);
  const row = (rows as unknown as Array<{ stones: number; claimed: number }>)[0] ?? { stones: 0, claimed: 0 };
  const claimable = Math.floor(row.stones / STONES_PER_SHARD) - row.claimed;
  return { stones: row.stones, claimed: row.claimed, claimable: Math.max(0, claimable) };
}

export async function claimShard(auth: AuthContext) {
  return withTransaction(async (tx) => {
    const definition = await ensureDefinition(tx, auth, {
      ...SHARD,
      kind: "collectible",
      description: "Five stones fuse into one shard. Claimed, never auto-converted.",
    });
    if (!definition) throw new ConflictError("The shard definition could not be created.");

    const rows = await tx.execute(sql`
      select
        count(*) filter (where d.key <> ${SHARD.key})::int as stones,
        count(*) filter (where d.key = ${SHARD.key})::int as claimed
      from reward_ledger l
      join reward_definitions d on d.id = l.reward_definition_id
      where l.workspace_id = ${auth.workspaceId}
    `);
    const row = (rows as unknown as Array<{ stones: number; claimed: number }>)[0] ?? { stones: 0, claimed: 0 };
    const claimable = Math.floor(row.stones / STONES_PER_SHARD) - row.claimed;
    if (claimable < 1) {
      throw new ConflictError(`No shard to claim yet - ${STONES_PER_SHARD - (row.stones % STONES_PER_SHARD)} more stone(s) to the next one.`);
    }

    try {
      const [entry] = await tx
        .insert(rewardLedger)
        .values({
          workspaceId: auth.workspaceId,
          rewardDefinitionId: definition.id,
          userId: auth.userId,
          reason: "adjustment",
          subjectType: "shard_claim",
          subjectId: null,
          points: 0,
          idempotencyKey: `shard-claim:${row.claimed + 1}`,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "reward.shard_claimed", subjectType: "reward_ledger", subjectId: entry.id, summary: `Shard claimed (${row.claimed + 1})` },
        tx,
      );
      return entry;
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new ConflictError("That shard was already claimed.");
      throw cause;
    }
  });
}
