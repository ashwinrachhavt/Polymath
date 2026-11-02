import type { FocusStrictness } from "../focus/schema";
import type { taskPriority } from "../work/schema";

/*
 * Spec §5's reward math and rule text as pure values and functions: the same
 * numbers the earning rules award and the durable page renders, in one named
 * place with no database in sight. Both the server commands and the client
 * surfaces read from here, so the rule a session awards is the rule the page
 * states - the drift this module exists to make impossible.
 *
 * The strictness and priority types are imported type-only from their owning
 * domains' schemas: this module stays pure (and client-importable) while the
 * enums remain the single contract. Enum values are append-only per the
 * domain READMEs - a new value must be given a multiplier here before it can
 * pay, which is the point.
 */

/** Spec §5: points multiply by how strictly the session was held. */
export const FOCUS_TIER_MULTIPLIER: Record<FocusStrictness, number> = {
  normal: 1,
  timeout: 1.5,
  deep: 2,
};

/** One award unit: every this-many focused seconds earns one point, times the tier. */
export const FOCUS_POINTS_UNIT_SECONDS = 600;

/** Points for a finished session: whole 10-minute units of banked focus, times the tier. */
export function focusPointsForSession(accumulatedSeconds: number, strictness: FocusStrictness): number {
  if (accumulatedSeconds <= 0) return 0;
  const units = Math.ceil(accumulatedSeconds / FOCUS_POINTS_UNIT_SECONDS);
  return Math.round(units * FOCUS_TIER_MULTIPLIER[strictness]);
}

/** Level 2 begins at this many points; each further level costs one more step of the same size. */
export const LEVEL_BASE_POINTS = 100;

/** Cumulative points where `level` begins: 100 × the (level−1)th triangular number. Level 1 starts at 0. */
export function pointsForLevel(level: number): number {
  if (level <= 1) return 0;
  return (LEVEL_BASE_POINTS * (level - 1) * level) / 2;
}

/** The level `points` has reached: the highest level whose threshold the points meet. */
export function levelForPoints(points: number): number {
  let level = 1;
  while (points >= pointsForLevel(level + 1)) level += 1;
  return level;
}

/** The level the mastery stone waits for (spec §5: diamond at level 5). */
export const DIAMOND_LEVEL = 5;

/** Spec §6: a definition can never price a jackpot - points are bounded. */
export const REWARD_DEFINITION_POINTS_MAX = 10000;

/** The consistency stone's streak length (spec §5: topaz at 7 consecutive earning days). */
export const TOPAZ_STREAK_DAYS = 7;

/** The deep-focus stone's minimum (spec §5: sapphire at 45 focused minutes, deep tier). */
export const SAPPHIRE_DEEP_MINIMUM_MINUTES = 45;

/** The priorities that count as a high-priority link (spec §5: ruby). */
export type TaskPriority = (typeof taskPriority.enumValues)[number];
export const RUBY_HIGH_PRIORITIES: TaskPriority[] = ["high", "urgent"];

/*
 * Spec §6 anti-gaming: the farmable stones stop paying. Focus pays per
 * session, so a script that starts-and-finishes sessions all day would farm
 * it without a cap; learning pays per sitting, so re-taking a known quiz
 * would. The caps are per user per day, counted over the points-bearing
 * award rows, and enforced in the award's own transaction.
 */
export const FOCUS_DAILY_CAP = 12;
export const LEARNING_DAILY_CAP = 1;

/**
 * Spec §6: a learning sitting pays only when at least two thirds of it
 * graded correct. Pure so the command and the tests share one gate; grading
 * itself is always the server's (completeQuizAttempt re-grades from the
 * persisted questions), so a client cannot talk its way past this.
 */
export function learningGateMet(correctCount: number, totalCount: number): boolean {
  return totalCount > 0 && correctCount * 3 >= totalCount * 2;
}

/** A day as the ledger writes it: YYYY-MM-DD in the workspace's timezone. */
const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (day: string) => new Date(`${day}T00:00:00Z`).getTime() / DAY_MS;
const shiftDay = (day: string, days: number) => new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);

/*
 * Streaks from ledger days: `longest` is the best run of consecutive earning
 * days; `current` counts back from today, or from yesterday when today has
 * not earned yet - the same one-day grace the preview's streak grants, so a
 * morning visit does not report a broken streak the afternoon would mend.
 */
export function streakFromDays(days: string[], today: string): { current: number; longest: number } {
  const sorted = [...new Set(days)].sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && dayNumber(day) - dayNumber(previous) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  const anchor = sorted.includes(today) ? today : sorted.includes(shiftDay(today, -1)) ? shiftDay(today, -1) : null;
  let current = 0;
  if (anchor) {
    current = 1;
    for (let cursor = shiftDay(anchor, -1); sorted.includes(cursor); cursor = shiftDay(cursor, -1)) current += 1;
  }
  return { current, longest };
}

/*
 * The earning rules' own words. The commands ensure these descriptions into
 * `reward_definitions` lazily (the row is created the first time a rule
 * fires), and the durable page falls back to them only while no definition
 * exists yet - once the row exists, its description is what renders.
 */

export type RuleText = { key: string; label: string; description: string };

/** The focus award itself: per-session points, priced here, never a static price. */
export const FOCUS_RULE: RuleText = {
  key: "focus",
  label: "Focus",
  description: "Finish a focus session: one point per focused 10 minutes, ×1 normal, ×1.5 timeout, ×2 deep.",
};

export const QUARTZ_RULE: RuleText = {
  key: "quartz",
  label: "Quartz",
  description: "First completed task of the day.",
};

export const GARNET_RULE: RuleText = {
  key: "garnet",
  label: "Garnet of Recovery",
  description: "Finish a focus session after letting one go. Earned once.",
};

export const TOPAZ_RULE: RuleText = {
  key: "topaz",
  label: "Topaz of Consistency",
  description: `Focus ${TOPAZ_STREAK_DAYS} days in a row. Earned once.`,
};

export const EMERALD_RULE: RuleText = {
  key: "emerald",
  label: "Emerald of Learning",
  description: "Complete a learning review with every answer correct. Earned once.",
};

export const SAPPHIRE_RULE: RuleText = {
  key: "sapphire",
  label: "Sapphire of Deep Focus",
  description: `Finish a deep-focus session of at least ${SAPPHIRE_DEEP_MINIMUM_MINUTES} focused minutes. Earned once.`,
};

export const RUBY_RULE: RuleText = {
  key: "ruby",
  label: "Ruby of Courage",
  description: "Finish a focus session on a high-priority task. Earned once.",
};

export const DIAMOND_RULE: RuleText = {
  key: "diamond",
  label: "Diamond of Mastery",
  description: `Reach level ${DIAMOND_LEVEL} - ${pointsForLevel(DIAMOND_LEVEL).toLocaleString("en-US")} points from the ledger. Earned once.`,
};
