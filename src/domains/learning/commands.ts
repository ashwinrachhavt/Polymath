import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { awardCoins } from "@/domains/stones/coins";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { gradeAttempt } from "./grading";
import { quizAttempts, quizQuestions, quizzes, type SubmittedAnswer } from "./schema";

/*
 * The attempt completion command. The completeTask shape: one transaction
 * writes the attempt, the audit row, and the coins it earned. The score is
 * computed server-side from the persisted questions - the client sends
 * answers, never a score - and a replayed completion reads the original
 * attempt instead of earning again.
 */

export class QuizAttemptError extends Error {
  constructor(
    public readonly code: "quiz_not_found" | "quiz_not_ready" | "invalid_answers" | "attempt_conflict",
    message: string,
  ) {
    super(message);
    this.name = "QuizAttemptError";
  }
}

export type CompleteQuizAttemptResult = {
  attemptId: string;
  correctCount: number;
  totalCount: number;
  /** Coins this call paid (0 on a replay, a repeat of the quiz today, or a spent daily ceiling). */
  coinsEarned: number;
  /** True when the idempotency key matched an attempt that already happened. */
  replayed: boolean;
};

/**
 * Validate the submitted sitting against the quiz's questions: exactly one
 * answer per question, no extras, and a selected value that is actually one
 * of that question's choices (or an honest "I don't know" with no value).
 * The boundary owns the check so grading can trust its input.
 */
function validateAnswers(
  questions: Array<Pick<typeof quizQuestions.$inferSelect, "id" | "choices">>,
  answers: SubmittedAnswer[],
): void {
  const byId = new Map(questions.map((q) => [q.id, q]));
  if (answers.length !== questions.length) {
    throw new QuizAttemptError("invalid_answers", "An attempt answers every question exactly once.");
  }
  const seen = new Set<string>();
  for (const a of answers) {
    if (!a || typeof a.questionId !== "string" || seen.has(a.questionId)) {
      throw new QuizAttemptError("invalid_answers", "An attempt answers every question exactly once.");
    }
    seen.add(a.questionId);
    const question = byId.get(a.questionId);
    if (!question)
      throw new QuizAttemptError("invalid_answers", "This answer names a question that is not part of the quiz.");
    if (a.dontKnow) {
      if (a.selectedValue !== null) {
        throw new QuizAttemptError("invalid_answers", 'An "I don\'t know" answer carries no selection.');
      }
      continue;
    }
    if (typeof a.selectedValue !== "string" || !question.choices.some((c) => c.value === a.selectedValue)) {
      throw new QuizAttemptError("invalid_answers", "This answer's selection is not one of the question's choices.");
    }
  }
}

/**
 * Complete a quiz attempt: re-grade server-side, persist the attempt, pay
 * its coins, and audit - all in one transaction. Replaying the same
 * idempotency key returns the original attempt without awarding again.
 */
export async function completeQuizAttempt(
  auth: AuthContext,
  input: { quizId: string; answers: SubmittedAnswer[]; idempotencyKey: string },
): Promise<CompleteQuizAttemptResult> {
  const [quiz] = await db
    .select({ id: quizzes.id, status: quizzes.status })
    .from(quizzes)
    .where(and(eq(quizzes.id, input.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!quiz) throw new QuizAttemptError("quiz_not_found", "No such quiz.");
  if (quiz.status !== "ready") throw new QuizAttemptError("quiz_not_ready", "This quiz is not ready to be taken.");

  const questions = await db
    .select({ id: quizQuestions.id, choices: quizQuestions.choices, answerValue: quizQuestions.answerValue })
    .from(quizQuestions)
    .where(and(eq(quizQuestions.quizId, quiz.id), eq(quizQuestions.workspaceId, auth.workspaceId)))
    .orderBy(quizQuestions.ordinal);
  if (questions.length === 0) throw new QuizAttemptError("quiz_not_ready", "This quiz has no questions to grade.");
  validateAnswers(questions, input.answers);

  const graded = gradeAttempt(questions, input.answers);

  return withTransaction(async (tx) => {
    const [attempt] = await tx
      .insert(quizAttempts)
      .values({
        workspaceId: auth.workspaceId,
        quizId: quiz.id,
        userId: auth.userId,
        answers: input.answers,
        correctCount: graded.correctCount,
        totalCount: graded.totalCount,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: [quizAttempts.workspaceId, quizAttempts.idempotencyKey] })
      .returning({ id: quizAttempts.id });

    if (!attempt) {
      // The attempt already happened. Return it rather than earning again;
      // a mismatched quiz or user behind the same key is a client bug
      // worth naming, not folding.
      const [existing] = await tx
        .select({
          id: quizAttempts.id,
          quizId: quizAttempts.quizId,
          userId: quizAttempts.userId,
          correctCount: quizAttempts.correctCount,
          totalCount: quizAttempts.totalCount,
        })
        .from(quizAttempts)
        .where(
          and(eq(quizAttempts.workspaceId, auth.workspaceId), eq(quizAttempts.idempotencyKey, input.idempotencyKey)),
        )
        .limit(1);
      if (!existing || existing.quizId !== quiz.id || existing.userId !== auth.userId) {
        throw new QuizAttemptError("attempt_conflict", "This attempt key already recorded a different sitting.");
      }
      return {
        attemptId: existing.id,
        correctCount: existing.correctCount,
        totalCount: existing.totalCount,
        coinsEarned: 0,
        replayed: true,
      };
    }

    const coinsEarned = await awardCoins(tx, auth, {
      kind: "quiz",
      quizId: quiz.id,
      attemptId: attempt.id,
      correct: graded.correctCount,
      total: graded.totalCount,
    });

    await recordAudit(
      auth,
      {
        action: "learning.quiz_completed",
        subjectType: "quiz_attempt",
        subjectId: attempt.id,
        summary: `Completed a quiz: ${graded.correctCount}/${graded.totalCount} correct`,
        metadata: {
          quizId: quiz.id,
          correctCount: graded.correctCount,
          totalCount: graded.totalCount,
          coinsEarned,
        },
      },
      tx,
    );

    return {
      attemptId: attempt.id,
      correctCount: graded.correctCount,
      totalCount: graded.totalCount,
      coinsEarned,
      replayed: false,
    };
  });
}
