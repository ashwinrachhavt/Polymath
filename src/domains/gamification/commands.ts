import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { FocusStrictness } from "@/domains/focus/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { isUniqueViolation } from "@/lib/pg-errors";
import {
  DIAMOND_LEVEL,
  DIAMOND_RULE,
  EMERALD_RULE,
  FOCUS_DAILY_CAP,
  FOCUS_RULE,
  GARNET_RULE,
  LEARNING_DAILY_CAP,
  RUBY_HIGH_PRIORITIES,
  RUBY_RULE,
  SAPPHIRE_DEEP_MINIMUM_MINUTES,
  SAPPHIRE_RULE,
  TOPAZ_RULE,
  TOPAZ_STREAK_DAYS,
  QUARTZ_RULE,
  focusPointsForSession,
  learningGateMet,
  levelForPoints,
  streakFromDays,
  type RuleText,
  type TaskPriority,
} from "./rules";
import { rewardDefinitions, rewardLedger, userProgress } from "./schema";

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
        {
          action: "reward_definition.created",
          subjectType: "reward_definition",
          subjectId: definition.id,
          summary: `Reward defined: ${definition.key}`,
        },
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
      {
        action: "reward_definition.updated",
        subjectType: "reward_definition",
        subjectId: updated.id,
        summary: `Reward updated: ${updated.key}`,
      },
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
    reason:
      "outcome_completed" | "focus_completed" | "task_completed" | "review_decided" | "weekly_review" | "adjustment";
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
        {
          action: "reward.awarded",
          subjectType: "reward_ledger",
          subjectId: entry.id,
          summary: `Reward earned: ${definition.key} (${input.reason})`,
        },
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
 * QUARTZ - one per user per day, on the first completed task. The day
 * boundary is the workspace timezone (user_preferences); the idempotency key
 * `quartz:<userId>:<day>` plus the per-user unique index makes "first of the
 * day, for this user" a database fact, and a replayed or second completion
 * is a silent skip, not an error. (Spec §6: the key is user-scoped - under
 * the old workspace-wide `quartz:<day>` key, whoever completed first claimed
 * the day and every other member silently earned nothing.) The definition is
 * created lazily with the donor's value (10 points) so the rule works
 * before anyone opens the definition form.
 *
 * SHARD - explicit claim, never auto-convert. Five recorded stones fuse into
 * one claimable shard (the donor's stonesPerShard = 5); claiming records a
 * ledger row against the lazily-created "shard" definition. The claim count
 * itself is the claimed marker, and the key `shard-claim:<n>` serializes a
 * racing double-claim into a ConflictError.
 */

export const STONES_PER_SHARD = 5;

const QUARTZ = { ...QUARTZ_RULE, points: 10 };
const SHARD = { key: "shard", label: "Shard", points: 0 };

type TxDrizzle = Parameters<Parameters<typeof withTransaction>[0]>[0];

/**
 * Today as the ledger writes it: YYYY-MM-DD in the workspace's timezone
 * (user_preferences, falling back to UTC) - the same boundary the day keys
 * and the daily caps count against.
 */
async function workspaceDay(tx: TxDrizzle, auth: AuthContext): Promise<string> {
  const rows = await tx.execute(sql`
    select to_char(timezone(coalesce(
      (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId} limit 1),
      'UTC'), now()), 'YYYY-MM-DD') as day
  `);
  return (rows as unknown as Array<{ day: string }>)[0].day;
}

/**
 * Spec §6: the per-user daily cap, enforced inside the award's own
 * transaction. The advisory lock serializes racing awards for the same user,
 * rule, and day (pg_advisory_xact_lock holds until commit), and the count
 * runs after it - so concurrent finishes cannot each read "11 of 12" and
 * both pay. Only points-bearing award rows count (reversals and zero-point
 * collectibles do not), keyed to the award's own definition so a stone row
 * for the same reason never consumes the budget.
 */
async function dailyCapReached(
  tx: TxDrizzle,
  auth: AuthContext,
  definitionKey: string,
  cap: number,
  day: string,
): Promise<boolean> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`reward_cap:${auth.workspaceId}:${auth.userId}:${definitionKey}:${day}`}, 0))`,
  );
  const rows = await tx.execute(sql`
    select count(*)::int as n
    from reward_ledger l
    join reward_definitions d on d.id = l.reward_definition_id
    where l.workspace_id = ${auth.workspaceId}
      and l.user_id = ${auth.userId}
      and d.key = ${definitionKey}
      and l.points > 0
      and to_char(timezone(coalesce(
        (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId} limit 1),
        'UTC'), l.created_at), 'YYYY-MM-DD') = ${day}
  `);
  const row = (rows as unknown as Array<{ n: number }>)[0];
  return row.n >= cap;
}

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
export async function recordDailyQuartz(
  tx: TxDrizzle,
  auth: AuthContext,
  taskId: string,
  note?: string,
): Promise<boolean> {
  const day = await workspaceDay(tx, auth);

  const definition = await ensureDefinition(tx, auth, {
    ...QUARTZ,
    kind: "points",
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
      note: note ?? null,
      points: definition.points,
      idempotencyKey: `quartz:${auth.userId}:${day}`,
    })
    .onConflictDoNothing({
      target: [rewardLedger.workspaceId, rewardLedger.userId, rewardLedger.idempotencyKey],
    })
    .returning();
  if (!entry) return false;
  await recordAudit(
    auth,
    { action: "reward.awarded", subjectType: "reward_ledger", subjectId: entry.id, summary: `Quartz earned (${day})` },
    tx,
  );
  return true;
}

/** The learning_reviewed definition, provisioned lazily with the donor's value. */
const LEARNING_REVIEWED = { key: "learning_reviewed", label: "Learning review", points: 10 };

/**
 * Called from learning attempt completion, inside the same transaction. The
 * learning twin of recordDailyQuartz: the definition is provisioned lazily
 * with the donor's value (10 points), the idempotency key names the attempt
 * (`quiz_attempt:<id>`), and a replayed award is a silent skip, never a game
 * error. Spec §6 hardening: the sitting must grade at least two thirds
 * correct (learningGateMet), and a user earns at most one learning award
 * per day (the cap), so re-taking a known quiz farms nothing. Returns
 * whether this call earned the stone.
 */
export async function recordLearningReview(
  tx: TxDrizzle,
  auth: AuthContext,
  input: { subjectId: string; idempotencyKey: string; correctCount: number; totalCount: number },
): Promise<boolean> {
  if (!learningGateMet(input.correctCount, input.totalCount)) return false;

  const definition = await ensureDefinition(tx, auth, {
    ...LEARNING_REVIEWED,
    kind: "points",
    description: "Completed a learning review.",
  });
  if (!definition || !definition.active) return false;

  const day = await workspaceDay(tx, auth);
  if (await dailyCapReached(tx, auth, definition.key, LEARNING_DAILY_CAP, day)) return false;

  const [entry] = await tx
    .insert(rewardLedger)
    .values({
      workspaceId: auth.workspaceId,
      rewardDefinitionId: definition.id,
      userId: auth.userId,
      reason: "learning_reviewed",
      subjectType: "quiz_attempt",
      subjectId: input.subjectId,
      points: definition.points,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [rewardLedger.workspaceId, rewardLedger.userId, rewardLedger.idempotencyKey],
    })
    .returning();
  if (!entry) return false;
  await recordAudit(
    auth,
    {
      action: "reward.awarded",
      subjectType: "reward_ledger",
      subjectId: entry.id,
      summary: `Learning stone earned (${LEARNING_REVIEWED.label})`,
    },
    tx,
  );
  return true;
}

/*
 * Spec §5: focus pays on the finish. Points are earned per session, not per
 * day: whole 10-minute units of banked focus, multiplied by how strictly the
 * session was held. The idempotency key names the session, so a replayed
 * finish is a silent skip, and the definition carries no static price - the
 * ledger row's points are the computed award.
 */
export type FocusRewardSession = {
  id: string;
  accumulatedSeconds: number;
  strictness: FocusStrictness;
  /** The linked task's priority, when the finisher touched one; null otherwise. */
  linkedTaskPriority: TaskPriority | null;
  /** Whether this user has ever let a session go - the recovery stone's premise. */
  followedAbandon: boolean;
};

/**
 * Called from finishFocusSession, inside the finish's own transaction. Never
 * throws for game reasons: a disabled definition, a replayed finish, or a
 * session with no banked time simply skips. Returns whether this call wrote
 * the award.
 */
export async function recordFocusReward(
  tx: TxDrizzle,
  auth: AuthContext,
  session: FocusRewardSession,
): Promise<boolean> {
  const points = focusPointsForSession(session.accumulatedSeconds, session.strictness);
  if (points <= 0) return false;

  const definition = await ensureDefinition(tx, auth, { ...FOCUS_RULE, kind: "points", points: 0 });
  if (!definition || !definition.active) return false;

  // Spec §6: a per-user daily cap on paid sessions, counted in this same
  // transaction (see dailyCapReached). A capped session still evaluates its
  // once-ever stones below - the cap limits the farmable points, not the
  // session's own record - but it writes no award row of its own.
  const day = await workspaceDay(tx, auth);
  const capReached = await dailyCapReached(tx, auth, definition.key, FOCUS_DAILY_CAP, day);

  if (!capReached) {
    const [entry] = await tx
      .insert(rewardLedger)
      .values({
        workspaceId: auth.workspaceId,
        rewardDefinitionId: definition.id,
        userId: auth.userId,
        reason: "focus_completed",
        subjectType: "focus_session",
        subjectId: session.id,
        points,
        idempotencyKey: `focus:${session.id}`,
      })
      .onConflictDoNothing({
        target: [rewardLedger.workspaceId, rewardLedger.userId, rewardLedger.idempotencyKey],
      })
      .returning();
    if (!entry) return false; // a replayed finish: the original already paid
    await recordAudit(
      auth,
      {
        action: "reward.awarded",
        subjectType: "reward_ledger",
        subjectId: entry.id,
        summary: `Focus earned (${points} pts, ${session.strictness})`,
      },
      tx,
    );
  }

  // Session-scoped stones (spec §5), each a first-time collectible keyed to
  // the user: sapphire holds a deep session to its 45-minute floor, ruby
  // links the finish to a high-priority task, garnet follows a let-go.
  if (session.strictness === "deep" && session.accumulatedSeconds >= SAPPHIRE_DEEP_MINIMUM_MINUTES * 60) {
    await recordStoneOnce(tx, auth, SAPPHIRE_RULE, {
      reason: "focus_completed",
      subjectType: "focus_session",
      subjectId: session.id,
    });
  }
  if (session.linkedTaskPriority !== null && RUBY_HIGH_PRIORITIES.includes(session.linkedTaskPriority)) {
    await recordStoneOnce(tx, auth, RUBY_RULE, {
      reason: "focus_completed",
      subjectType: "focus_session",
      subjectId: session.id,
    });
  }
  if (session.followedAbandon) {
    await recordStoneOnce(tx, auth, GARNET_RULE, {
      reason: "focus_completed",
      subjectType: "focus_session",
      subjectId: session.id,
    });
  }

  // The progress cache moves in the same transaction: total points are the
  // ledger's own sum, streaks come from its distinct earning days in the
  // workspace's timezone (today's award is already in the set), so the cache
  // can only ever be as right as the rows it summarizes - there is no second
  // place for the truth to live.
  const progress = await ledgerProgress(tx, auth);
  const streak = streakFromDays(progress.days, progress.today);
  if (streak.current >= TOPAZ_STREAK_DAYS) {
    await recordStoneOnce(tx, auth, TOPAZ_RULE, {
      reason: "focus_completed",
      subjectType: "focus_session",
      subjectId: session.id,
    });
  }
  if (levelForPoints(progress.totalPoints) >= DIAMOND_LEVEL) {
    await recordStoneOnce(tx, auth, DIAMOND_RULE, {
      reason: "focus_completed",
      subjectType: "focus_session",
      subjectId: session.id,
    });
  }
  await upsertUserProgress(tx, auth, {
    totalPoints: progress.totalPoints,
    currentStreakDays: streak.current,
    longestStreakDays: streak.longest,
    lastActiveOn: progress.days.length > 0 ? progress.days[progress.days.length - 1] : null,
  });
  return !capReached;
}

/*
 * The stones are first-time collectibles: one ledger row per user, ever,
 * keyed `<stone>:<userId>`. The definition row materializes lazily on first
 * fire, carrying the rule's own words - the text the durable page renders.
 * A stone never announces points (its row is worth zero); it marks that a
 * threshold was met.
 */
type StoneTrigger = { reason: "focus_completed" | "learning_reviewed"; subjectType: string; subjectId: string | null };

async function recordStoneOnce(
  tx: TxDrizzle,
  auth: AuthContext,
  stone: RuleText,
  trigger: StoneTrigger,
): Promise<boolean> {
  const definition = await ensureDefinition(tx, auth, { ...stone, kind: "collectible", points: 0 });
  if (!definition || !definition.active) return false;

  const [entry] = await tx
    .insert(rewardLedger)
    .values({
      workspaceId: auth.workspaceId,
      rewardDefinitionId: definition.id,
      userId: auth.userId,
      reason: trigger.reason,
      subjectType: trigger.subjectType,
      subjectId: trigger.subjectId,
      points: 0,
      idempotencyKey: `${stone.key}:${auth.userId}`,
    })
    .onConflictDoNothing({
      target: [rewardLedger.workspaceId, rewardLedger.userId, rewardLedger.idempotencyKey],
    })
    .returning();
  if (!entry) return false;
  await recordAudit(
    auth,
    {
      action: "reward.awarded",
      subjectType: "reward_ledger",
      subjectId: entry.id,
      summary: `Stone earned: ${stone.label}`,
    },
    tx,
  );
  return true;
}

/**
 * Spec §5: the emerald is the gated learning stone - a perfect,
 * server-graded sitting earns it, once per user. Grading has already run in
 * completeQuizAttempt, and a dontKnow answer never grades correct, so a
 * perfect sitting answered every question honestly.
 */
export async function recordEmerald(tx: TxDrizzle, auth: AuthContext, attemptId: string): Promise<boolean> {
  return recordStoneOnce(tx, auth, EMERALD_RULE, {
    reason: "learning_reviewed",
    subjectType: "quiz_attempt",
    subjectId: attemptId,
  });
}

/*
 * The ledger, summarized for user_progress: one query for the user's point
 * total, their distinct earning days, and today's date in the workspace's
 * timezone - the same convention recordDailyQuartz uses to pick the day a
 * reward belongs to.
 */
async function ledgerProgress(
  tx: TxDrizzle,
  auth: AuthContext,
): Promise<{ totalPoints: number; days: string[]; today: string }> {
  const rows = await tx.execute(sql`
    with prefs as (
      select coalesce((select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId} limit 1), 'UTC') as tz
    )
    select
      coalesce(sum(points), 0)::int as total_points,
      coalesce(array_agg(distinct day order by day), '{}') as days,
      to_char(timezone((select tz from prefs), now()), 'YYYY-MM-DD') as today
    from (
      select points, to_char(timezone((select tz from prefs), created_at), 'YYYY-MM-DD') as day
      from reward_ledger
      where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}
    ) t
  `);
  // drizzle's execute returns an untyped record bag; this query has exactly
  // one row with three named columns.
  const row = (rows as unknown as Array<{ total_points: number; days: string[]; today: string }>)[0];
  return { totalPoints: row.total_points, days: row.days, today: row.today };
}

/** The only writer of user_progress: an upsert keyed to the (workspace, user) pair. */
async function upsertUserProgress(
  tx: TxDrizzle,
  auth: AuthContext,
  input: { totalPoints: number; currentStreakDays: number; longestStreakDays: number; lastActiveOn: string | null },
): Promise<void> {
  await tx
    .insert(userProgress)
    .values({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      totalPoints: input.totalPoints,
      currentStreakDays: input.currentStreakDays,
      longestStreakDays: input.longestStreakDays,
      lastActiveOn: input.lastActiveOn,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoUpdate({
      target: [userProgress.workspaceId, userProgress.userId],
      set: {
        totalPoints: input.totalPoints,
        currentStreakDays: input.currentStreakDays,
        longestStreakDays: input.longestStreakDays,
        lastActiveOn: input.lastActiveOn,
        version: sql`${userProgress.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      },
    });
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
      throw new ConflictError(
        `No shard to claim yet - ${STONES_PER_SHARD - (row.stones % STONES_PER_SHARD)} more stone(s) to the next one.`,
      );
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
        {
          action: "reward.shard_claimed",
          subjectType: "reward_ledger",
          subjectId: entry.id,
          summary: `Shard claimed (${row.claimed + 1})`,
        },
        tx,
      );
      return entry;
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new ConflictError("That shard was already claimed.");
      throw cause;
    }
  });
}
