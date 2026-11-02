import type { QuizQuestion, SubmittedAnswer } from "./schema";

/*
 * Pure grading fold (the foldReadingEvent contract): no database, no clock,
 * no I/O - the unit suite proves it under the default-deny fetch guard. The
 * server re-grades every attempt through this function before persisting, so
 * a client-supplied score has no path into the ledger.
 *
 * Grading compares VALUES, not positions: `answerValue` names the correct
 * choice's `value`, so display-order shuffling in the runner cannot corrupt
 * a score. `dontKnow` is never correct - an honest gap is not a wrong guess
 * - and grades false while the runner renders it differently from a miss.
 */

export type GradeResult = {
  correctCount: number;
  totalCount: number;
  perQuestion: Array<{ questionId: string; correct: boolean; dontKnow: boolean }>;
};

export function gradeAttempt(
  questions: Array<Pick<QuizQuestion, "id" | "answerValue">>,
  answers: SubmittedAnswer[],
): GradeResult {
  const byQuestionId = new Map(answers.map((a) => [a.questionId, a]));
  let correctCount = 0;
  const perQuestion = questions.map((q) => {
    const answer = byQuestionId.get(q.id);
    // A missing answer grades as a gap, never a guess: the fold is total
    // over the sitting the client actually sent.
    const dontKnow = !answer || answer.dontKnow || answer.selectedValue === null;
    const correct = !!answer && !dontKnow && answer.selectedValue === q.answerValue;
    if (correct) correctCount++;
    return { questionId: q.id, correct, dontKnow };
  });
  return { correctCount, totalCount: questions.length, perQuestion };
}
