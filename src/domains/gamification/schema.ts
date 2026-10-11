import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";

/*
 * The ledger is the truth; the projection is derived. Inventory is computed
 * from `reward_ledger` rather than stored per collectible class — one table
 * until behaviour genuinely differs, which it does not yet.
 *
 * Rewards are optional and disableable, and they reinforce completion and
 * review. They never equate activity with accomplishment.
 */

export const rewardKind = pgEnum("reward_kind", ["points", "streak_day", "badge", "collectible"]);
export const ledgerReason = pgEnum("ledger_reason", [
  "outcome_completed",
  "focus_completed",
  "task_completed",
  "review_decided",
  "learning_reviewed",
  "weekly_review",
  "adjustment",
]);

export const rewardDefinitions = pgTable(
  "reward_definitions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    key: text("key").notNull(),
    kind: rewardKind("kind").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    points: integer("points").notNull().default(0),
    /** Required count of the underlying action, for badges and streaks. */
    threshold: integer("threshold").notNull().default(1),
    /** A text equivalent always accompanies the visual, for accessibility. */
    accessibilityLabel: text("accessibility_label"),
    active: boolean("active").notNull().default(true),
    ...mutable,
  },
  (t) => [uniqueIndex("reward_definitions_key").on(t.workspaceId, t.key)],
);

/*
 * Append-only. Every row carries the idempotency key of the event that earned
 * it, so re-running a completion cannot award the same reward twice.
 */
export const rewardLedger = pgTable(
  "reward_ledger",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    rewardDefinitionId: uuid("reward_definition_id")
      .notNull()
      .references(() => rewardDefinitions.id, { onDelete: "restrict" }),
    userId: uuid("user_id"),
    reason: ledgerReason("reason").notNull(),
    /** What earned it: the outcome, session, task, or review. */
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    points: integer("points").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("reward_ledger_idempotency_key").on(t.workspaceId, t.idempotencyKey),
    index("reward_ledger_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

/** A cached read model. Rebuildable from the ledger at any time. */
export const userProgress = pgTable(
  "user_progress",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id").notNull(),
    totalPoints: integer("total_points").notNull().default(0),
    currentStreakDays: integer("current_streak_days").notNull().default(0),
    longestStreakDays: integer("longest_streak_days").notNull().default(0),
    /** { badgeKey: earnedAt } — derived from the ledger, not authoritative. */
    badges: jsonb("badges").notNull().default({}),
    lastActiveOn: date("last_active_on"),
    ...mutable,
  },
  (t) => [uniqueIndex("user_progress_workspace_user_key").on(t.workspaceId, t.userId)],
);

/** One row per day, for streaks and the weekly review. */
export const dailySnapshots = pgTable(
  "daily_snapshots",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id").notNull(),
    onDate: date("on_date").notNull(),
    outcomesAccepted: integer("outcomes_accepted").notNull().default(0),
    outcomesCompleted: integer("outcomes_completed").notNull().default(0),
    focusMinutes: integer("focus_minutes").notNull().default(0),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    reviewsDecided: integer("reviews_decided").notNull().default(0),
    capturesProcessed: integer("captures_processed").notNull().default(0),
    pointsEarned: integer("points_earned").notNull().default(0),
    ...recorded,
  },
  (t) => [
    uniqueIndex("daily_snapshots_day_key").on(t.workspaceId, t.userId, t.onDate),
    index("daily_snapshots_range_idx").on(t.workspaceId, t.onDate),
  ],
);
