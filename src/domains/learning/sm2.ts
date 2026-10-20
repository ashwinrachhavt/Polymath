/*
 * SM-2 scheduling, as one pure function. The table stores what this returns;
 * nothing else computes an interval.
 *
 * The columns are shaped by history, not by this algorithm: `ease_factor` is
 * text because the v1 table predates the quiz work, and `interval_days` is an
 * integer because a review can only be scheduled on a day boundary. Parsing the
 * text here once, with a floor, is cheaper than a column rewrite and keeps the
 * arithmetic in one tested place.
 *
 * The five results map to SM-2 quality the way the product means them:
 *   forgot    -> 0  reset the interval, ease drops
 *   struggled -> 2  repeat soon, ease drops
 *   recalled  -> 3  the first passing grade, interval grows slowly
 *   explained -> 4  explain it back, interval grows faster
 *   applied   -> 5  used it on real work, fastest growth
 */

export type LearningResult = "forgot" | "struggled" | "recalled" | "explained" | "applied";

const QUALITY: Record<LearningResult, number> = {
  forgot: 0,
  struggled: 2,
  recalled: 3,
  explained: 4,
  applied: 5,
};

/** SM-2 forbids ease below 1.3; below that a card becomes effectively permanent. */
export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
/** Days before the first successful review. */
const FIRST_INTERVAL = 1;
const SECOND_INTERVAL = 6;

export type ScheduleState = {
  intervalDays: number;
  easeFactor: number | string;
  reviewCount: number;
};

export type Schedule = { intervalDays: number; easeFactor: number; dueOn: Date };

/** Tolerant parse: a legacy row may hold a number, a numeric string, or nothing. */
export function parseEase(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n >= MIN_EASE ? n : DEFAULT_EASE;
}

export function nextSchedule(
  state: ScheduleState,
  result: LearningResult,
  now: Date = new Date(),
): Schedule {
  const q = QUALITY[result];
  const ease = Math.max(MIN_EASE, parseEase(state.easeFactor) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  let interval: number;
  if (q < 3) {
    // A failed recall restarts the ladder; the ease penalty still applies.
    interval = FIRST_INTERVAL;
  } else if (state.reviewCount === 0) {
    interval = FIRST_INTERVAL;
  } else if (state.reviewCount === 1) {
    interval = SECOND_INTERVAL;
  } else {
    interval = Math.round(Math.max(FIRST_INTERVAL, state.intervalDays) * ease);
  }

  const dueOn = new Date(now);
  dueOn.setDate(dueOn.getDate() + interval);

  return { intervalDays: interval, easeFactor: round2(ease), dueOn };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
