/*
 * What a finished piece of work is worth in coins: the one place the earning
 * rules live. Pure, so the ledger write (coins.ts), the tests and the shop's
 * "how to earn" text all read the same numbers.
 *
 * Each completion has a score from 0 to 1 and pays a base for finishing plus
 * a share for the score. Two limits stop farming:
 * - the idempotency key names the paying event, and for repeatable work it
 *   includes the day, so the same quiz, card or mission pays at most once a
 *   day and the same task once ever;
 * - each kind of work has a daily ceiling per person; an award that would
 *   pass it pays only what is left.
 */

export type Completion =
  /** A graded quiz sitting. Pays once per quiz per day. */
  | { kind: "quiz"; quizId: string; attemptId: string; correct: number; total: number }
  /**
   * A flashcard rated. Ratings are self-reported, so every honest rating pays
   * the same: paying more for "easy" would pay for claiming to know it.
   */
  | { kind: "flashcard"; flashcardId: string }
  /** A task moved to done. Pays once per task, ever: reopening and finishing again pays nothing. */
  | { kind: "task"; taskId: string }
  /** A finished mock interview; readiness is the share of asked concepts proven unaided. */
  | { kind: "mission_mock"; missionId: string; sessionId: string; proven: number; asked: number };

export type CoinRule = {
  reason: "quiz_completed" | "flashcard_reviewed" | "task_completed" | "mission_mock_completed";
  base: number;
  /** Paid in proportion to the completion score. */
  forScore: number;
  /** Most a person can earn from this kind of work in one day. */
  dailyCap: number;
};

/** Fewer questions than this is not a sitting worth paying for. */
const QUIZ_MIN_QUESTIONS = 3;

export const COIN_RULES = {
  quiz: { reason: "quiz_completed", base: 10, forScore: 40, dailyCap: 200 },
  flashcard: { reason: "flashcard_reviewed", base: 2, forScore: 0, dailyCap: 60 },
  task: { reason: "task_completed", base: 5, forScore: 0, dailyCap: 50 },
  mission_mock: { reason: "mission_mock_completed", base: 30, forScore: 120, dailyCap: 300 },
} as const satisfies Record<Completion["kind"], CoinRule>;

export type CoinAward = {
  reason: CoinRule["reason"];
  /** Before the daily ceiling is applied. */
  amount: number;
  dailyCap: number;
  idempotencyKey: string;
  subjectId: string;
};

/** The completion's score from 0 to 1, or null when it is too small to pay. */
function completionScore(completion: Completion): number | null {
  switch (completion.kind) {
    case "quiz":
      return completion.total >= QUIZ_MIN_QUESTIONS ? completion.correct / completion.total : null;
    case "mission_mock":
      return completion.asked > 0 ? completion.proven / completion.asked : null;
    case "flashcard":
    case "task":
      return 1;
  }
}

function eventKey(completion: Completion, day: string): { key: string; subjectId: string } {
  switch (completion.kind) {
    case "quiz":
      return { key: `quiz:${completion.quizId}:${day}`, subjectId: completion.attemptId };
    case "flashcard":
      return { key: `flashcard:${completion.flashcardId}:${day}`, subjectId: completion.flashcardId };
    case "task":
      return { key: `task:${completion.taskId}`, subjectId: completion.taskId };
    case "mission_mock":
      return { key: `mission_mock:${completion.missionId}:${day}`, subjectId: completion.sessionId };
  }
}

/**
 * The award a completion earns on `day` (YYYY-MM-DD in the person's
 * timezone), before the daily ceiling. Null when it earns nothing.
 */
export function coinAwardFor(completion: Completion, day: string): CoinAward | null {
  const score = completionScore(completion);
  if (score === null) return null;
  const rule: CoinRule = COIN_RULES[completion.kind];
  const { key, subjectId } = eventKey(completion, day);
  return {
    reason: rule.reason,
    amount: rule.base + Math.round(rule.forScore * Math.min(1, Math.max(0, score))),
    dailyCap: rule.dailyCap,
    idempotencyKey: key,
    subjectId,
  };
}
