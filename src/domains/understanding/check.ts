import { and, asc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { concepts } from "@/domains/knowledge/schema";
import { completeQuizAttempt, QuizAttemptError } from "@/domains/learning/commands";
import {
  conceptLinks,
  quizAttempts,
  quizQuestions,
  quizzes,
  type QuizChoice,
  type SubmittedAnswer,
} from "@/domains/learning/schema";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { codeExplainers } from "./schema";
import { ownedExplainer, PASS_MARK } from "./explainers";
import { addReviewItems } from "./review";

/*
 * The check: the explainer's quiz, answered anywhere. A terminal sitting and a
 * sitting in the app are the same quiz and grade through the same server-side
 * fold (completeQuizAttempt); what this module adds is what the sitting means
 * for an explainer. Missed answers become review items, and the concepts they
 * tested are named back to the person.
 */

export class ExplainerNotReadyError extends Error {
  constructor() {
    super("This explainer is still being written. Try again in a moment.");
    this.name = "ExplainerNotReadyError";
  }
}

export class ExplainerNotFoundError extends Error {
  constructor() {
    super("No such explainer.");
    this.name = "ExplainerNotFoundError";
  }
}

export class InvalidCheckAnswersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCheckAnswersError";
  }
}

async function readyExplainer(auth: AuthContext, explainerId: string) {
  const [explainer] = await db.select().from(codeExplainers).where(ownedExplainer(auth, explainerId)).limit(1);
  if (!explainer) throw new ExplainerNotFoundError();
  if (!explainer.quizId) throw new ExplainerNotReadyError();
  return { ...explainer, quizId: explainer.quizId };
}

async function questionsOf(auth: AuthContext, quizId: string) {
  const rows = await db
    .select({
      id: quizQuestions.id,
      prompt: quizQuestions.prompt,
      choices: quizQuestions.choices,
      answerValue: quizQuestions.answerValue,
      explanation: quizQuestions.explanation,
      evidence: quizQuestions.evidence,
    })
    .from(quizQuestions)
    .where(and(eq(quizQuestions.quizId, quizId), eq(quizQuestions.workspaceId, auth.workspaceId)))
    .orderBy(asc(quizQuestions.ordinal));
  const terms = await db
    .select({ questionId: conceptLinks.quizQuestionId, term: concepts.term })
    .from(conceptLinks)
    .innerJoin(
      concepts,
      and(eq(concepts.id, conceptLinks.conceptId), eq(concepts.workspaceId, conceptLinks.workspaceId)),
    )
    .where(
      and(
        eq(conceptLinks.workspaceId, auth.workspaceId),
        inArray(
          conceptLinks.quizQuestionId,
          rows.map((row) => row.id),
        ),
      ),
    );
  const concept = new Map(terms.map((row) => [row.questionId, row.term]));
  return rows.map((row) => ({ ...row, concept: concept.get(row.id) ?? null }));
}

/** The questions, without their answers. */
export async function getCheck(auth: AuthContext, explainerId: string) {
  const explainer = await readyExplainer(auth, explainerId);
  const questions = await questionsOf(auth, explainer.quizId);
  return {
    quizId: explainer.quizId,
    questions: questions.map(({ id, prompt, choices }) => ({ id, prompt, choices })),
  };
}

type CheckAnswer = { questionId: string; value: string | null };

type CheckResult = {
  correct: number;
  total: number;
  passed: boolean;
  passMark: number;
  questions: Array<{
    id: string;
    prompt: string;
    correct: boolean;
    yourValue: string | null;
    answerValue: string;
    answerLabel: string;
    explanation: string;
    concept: string | null;
  }>;
  missedConcepts: string[];
  reviewItemsAdded: number;
  quizPath: string;
};

function labelOf(choices: QuizChoice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

/**
 * Grades a sitting. A question left out counts as "I don't know", so an agent
 * may send only what the person answered. The idempotency key names the quiz
 * and the exact answers, so sending the same sitting twice records it once.
 */
export async function submitCheck(
  auth: AuthContext,
  explainerId: string,
  answers: CheckAnswer[],
): Promise<CheckResult> {
  const explainer = await readyExplainer(auth, explainerId);
  const questions = await questionsOf(auth, explainer.quizId);
  const known = new Set(questions.map((question) => question.id));
  if (answers.some((answer) => !known.has(answer.questionId))) {
    throw new InvalidCheckAnswersError("An answer names a question that is not part of this check.");
  }
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer.value]));
  const submitted: SubmittedAnswer[] = questions.map((question) => {
    const value = byQuestion.get(question.id) ?? null;
    return { questionId: question.id, selectedValue: value, dontKnow: value === null };
  });
  const key = `understanding:${explainer.quizId}:${(await sha256Hex(JSON.stringify(submitted))).slice(0, 24)}`;
  let attempt;
  try {
    attempt = await completeQuizAttempt(auth, { quizId: explainer.quizId, answers: submitted, idempotencyKey: key });
  } catch (cause) {
    if (cause instanceof QuizAttemptError && cause.code === "invalid_answers") {
      throw new InvalidCheckAnswersError("An answer is not one of the question's choices.");
    }
    throw cause;
  }
  const outcome = await recordCheckOutcome(auth, attempt.attemptId);
  return {
    correct: attempt.correctCount,
    total: attempt.totalCount,
    passed: attempt.correctCount >= Math.ceil(attempt.totalCount * PASS_MARK),
    passMark: PASS_MARK,
    questions: questions.map((question) => {
      const given = submitted.find((answer) => answer.questionId === question.id)!;
      return {
        id: question.id,
        prompt: question.prompt,
        correct: given.selectedValue === question.answerValue,
        yourValue: given.selectedValue,
        answerValue: question.answerValue,
        answerLabel: labelOf(question.choices, question.answerValue),
        explanation: question.explanation,
        concept: question.concept,
      };
    }),
    missedConcepts: outcome?.missedConcepts ?? [],
    reviewItemsAdded: outcome?.reviewItemsAdded ?? 0,
    quizPath: `/learn/quizzes/${explainer.quizId}`,
  };
}

/**
 * What a finished sitting means for an explainer's quiz: its missed answers
 * become review items and the concepts they tested are named. A sitting on any
 * other quiz returns null, so the app's quiz screen can call this after every
 * sitting and only explainer quizzes react.
 */
export async function recordCheckOutcome(
  auth: AuthContext,
  attemptId: string,
): Promise<{ missedConcepts: string[]; reviewItemsAdded: number } | null> {
  const [attempt] = await db
    .select({ quizId: quizAttempts.quizId, answers: quizAttempts.answers })
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.id, attemptId),
        eq(quizAttempts.workspaceId, auth.workspaceId),
        eq(quizAttempts.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!attempt) return null;
  const [explainer] = await db
    .select({ id: codeExplainers.id })
    .from(codeExplainers)
    .where(and(eq(codeExplainers.workspaceId, auth.workspaceId), eq(codeExplainers.quizId, attempt.quizId)))
    .limit(1);
  if (!explainer) return null;
  const [quiz] = await db
    .select({ title: quizzes.title, documentId: quizzes.documentId, extractionId: quizzes.sourceExtractionId })
    .from(quizzes)
    .where(and(eq(quizzes.id, attempt.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .limit(1);
  const questions = await questionsOf(auth, attempt.quizId);
  const given = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
  const missed = questions.filter((question) => {
    const answer = given.get(question.id);
    return !answer || answer.dontKnow || answer.selectedValue !== question.answerValue;
  });
  const missedConcepts = [...new Set(missed.flatMap((question) => (question.concept ? [question.concept] : [])))];
  const reviewItemsAdded = await addReviewItems(auth, {
    attemptId,
    title: `Missed: ${quiz.title}`,
    source: { documentId: quiz.documentId, extractionId: quiz.extractionId, title: quiz.title },
    items: missed.flatMap((question) =>
      question.concept
        ? [
            {
              prompt: question.prompt,
              answer: `${labelOf(question.choices, question.answerValue)}. ${question.explanation}`,
              evidence: {
                quote: question.evidence.quote,
                startOffset: question.evidence.startOffset,
                endOffset: question.evidence.endOffset,
              },
              concept: question.concept,
            },
          ]
        : [],
    ),
  });
  return { missedConcepts, reviewItemsAdded };
}
