/*
 * Recall scheduling, as one pure function. The cards table stores what this
 * returns; nothing else computes an interval.
 *
 * Ported from the Learning domain's sm2.ts, which #222 deleted with the
 * feature: same ladder, ease floor and failed-restart arithmetic, narrowed to
 * the two outcomes the Product Spec's "Zettel Cards and recall" names -
 * answered-correctly and answered-wrong. Review is retrieval, not
 * recognition, so there are no options and no answer_index here.
 *
 * One deliberate deviation from SM-2: a wrong answer is due again in
 * RETRY_MINUTES, not tomorrow. The spec's rule is "failed cards return
 * sooner", and a four-minute review session only teaches if the miss comes
 * back inside it. The interval ladder still restarts, so the next correct
 * answer grows from the bottom again.
 *
 * Ceiling: binary grading converges ease to the floor, so intervals grow at
 * the slowest passing rate. The five-grade scale (forgot .. applied) from
 * Learning is the upgrade path if finer grading returns - card_reviews.outcome
 * is an enum that can widen, and QUALITY is the only place that grades.
 */

export type RecallOutcome = "correct" | "wrong";

const QUALITY: Record<RecallOutcome, number> = { wrong: 0, correct: 3 };

/** SM-2 forbids ease below 1.3; below that a card becomes effectively permanent. */
export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
/** Days before the first successful review, and after the second. */
const FIRST_INTERVAL = 1;
const SECOND_INTERVAL = 6;
/** A missed card re-enters the queue this soon, inside the same sitting. */
export const RETRY_MINUTES = 10;

export type RecallScheduleState = {
  intervalDays: number;
  easeFactor: number;
  reviewCount: number;
};

export type RecallSchedule = { intervalDays: number; easeFactor: number; dueAt: Date };

export function nextRecallDue(
  state: RecallScheduleState,
  outcome: RecallOutcome,
  now: Date = new Date(),
): RecallSchedule {
  const q = QUALITY[outcome];
  const ease = Math.max(MIN_EASE, state.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  if (q < 3) {
    // A failed recall restarts the ladder and comes back within the sitting.
    const dueAt = new Date(now.getTime() + RETRY_MINUTES * 60_000);
    return { intervalDays: FIRST_INTERVAL, easeFactor: round2(ease), dueAt };
  }

  let interval: number;
  if (state.reviewCount === 0) {
    interval = FIRST_INTERVAL;
  } else if (state.reviewCount === 1) {
    interval = SECOND_INTERVAL;
  } else {
    interval = Math.round(Math.max(FIRST_INTERVAL, state.intervalDays) * ease);
  }

  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + interval);
  return { intervalDays: interval, easeFactor: round2(ease), dueAt };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
