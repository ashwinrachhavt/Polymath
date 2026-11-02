import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { documents } from "@/domains/knowledge/schema";
import { currentExtractionSql } from "@/domains/knowledge/versions";
import { quizAttempts, quizQuestions, quizzes, type QuizEvidence } from "./schema";

/*
 * Every read the Learn surface needs, so UI code never joins across domains.
 * The library's per-document aggregates describe the quiz the user can act
 * on now - the latest ready quiz - not the history of superseded
 * generations: "best score" and "last attempted" on a quiz you cannot retake
 * would be a number that lies.
 */

export type LearnLibraryRow = {
  documentId: string;
  title: string;
  /** False while the document has no current succeeded extraction. */
  quizzable: boolean;
  quizId: string | null;
  questionCount: number | null;
  /** The user's best score on the current quiz, correct out of questionCount. */
  bestCorrect: number | null;
  lastAttemptedAt: string | Date | null;
};

export type QuizForSitting = {
  id: string;
  documentId: string;
  title: string;
  questions: Array<{
    id: string;
    ordinal: number;
    prompt: string;
    choices: Array<{ value: string; label: string }>;
    answerValue: string;
    explanation: string;
    evidence: QuizEvidence;
  }>;
};

/** Latest ready quiz per document, latest generation winning. */
function latestReadyQuizByDocument<T extends { documentId: string; createdAt: Date }>(rows: T[]): Map<string, T> {
  const byDocument = new Map<string, T>();
  for (const row of rows) {
    // Rows arrive newest-first, so the first sight of a document is its
    // latest ready quiz.
    if (!byDocument.has(row.documentId)) byDocument.set(row.documentId, row);
  }
  return byDocument;
}

/** The learning library: every captured document with its learning state. */
export async function getLearnLibrary(auth: AuthContext): Promise<LearnLibraryRow[]> {
  const documentRows = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      quizzable: sql<boolean>`${currentExtractionSql("status")} = 'succeeded'`,
    })
    .from(documents)
    .where(eq(documents.workspaceId, auth.workspaceId))
    .orderBy(desc(documents.createdAt));
  if (documentRows.length === 0) return [];

  const quizRows = await db
    .select({
      id: quizzes.id,
      documentId: quizzes.documentId,
      createdAt: quizzes.createdAt,
      questionCount: quizzes.questionCount,
    })
    .from(quizzes)
    .where(and(eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.status, "ready")))
    .orderBy(desc(quizzes.createdAt));
  const latestByDocument = latestReadyQuizByDocument(quizRows);
  const latestQuizIds = [...latestByDocument.values()].map((q) => q.id);

  const attemptRows =
    latestQuizIds.length === 0
      ? []
      : await db
          .select({
            quizId: quizAttempts.quizId,
            bestCorrect: sql<number>`max(${quizAttempts.correctCount})::int`,
            lastAttemptedAt: sql<string | Date>`max(${quizAttempts.createdAt})`,
          })
          .from(quizAttempts)
          .where(
            and(
              eq(quizAttempts.workspaceId, auth.workspaceId),
              eq(quizAttempts.userId, auth.userId),
              inArray(quizAttempts.quizId, latestQuizIds),
            ),
          )
          .groupBy(quizAttempts.quizId);
  const attemptsByQuiz = new Map(attemptRows.map((a) => [a.quizId, a]));

  return documentRows.map((doc) => {
    const quiz = latestByDocument.get(doc.documentId);
    const attempts = quiz ? attemptsByQuiz.get(quiz.id) : undefined;
    return {
      documentId: doc.documentId,
      title: doc.title,
      quizzable: doc.quizzable,
      quizId: quiz?.id ?? null,
      questionCount: quiz?.questionCount ?? null,
      bestCorrect: attempts?.bestCorrect ?? null,
      lastAttemptedAt: attempts?.lastAttemptedAt ?? null,
    };
  });
}

/** The latest ready quiz for one document, or null when none exists. */
export async function latestReadyQuizForDocument(auth: AuthContext, documentId: string) {
  const [quiz] = await db
    .select({ id: quizzes.id, questionCount: quizzes.questionCount, sourceExtractionId: quizzes.sourceExtractionId })
    .from(quizzes)
    .where(
      and(eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.documentId, documentId), eq(quizzes.status, "ready")),
    )
    .orderBy(desc(quizzes.createdAt))
    .limit(1);
  return quiz ?? null;
}

/**
 * The quiz a sitting runs against, with its questions in ordinal order and
 * everything instant feedback needs: values, explanations, evidence. The
 * server re-grades on completion, so revealing answerValue to the runner is
 * a UX choice, not a scoring trust.
 */
export async function getQuizForSitting(auth: AuthContext, quizId: string): Promise<QuizForSitting | null> {
  const [quiz] = await db
    .select({ id: quizzes.id, documentId: quizzes.documentId, title: quizzes.title })
    .from(quizzes)
    .where(and(eq(quizzes.id, quizId), eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.status, "ready")))
    .limit(1);
  if (!quiz) return null;
  const questions = await db
    .select({
      id: quizQuestions.id,
      ordinal: quizQuestions.ordinal,
      prompt: quizQuestions.prompt,
      choices: quizQuestions.choices,
      answerValue: quizQuestions.answerValue,
      explanation: quizQuestions.explanation,
      evidence: quizQuestions.evidence,
    })
    .from(quizQuestions)
    .where(and(eq(quizQuestions.quizId, quiz.id), eq(quizQuestions.workspaceId, auth.workspaceId)))
    .orderBy(quizQuestions.ordinal);
  return { ...quiz, questions };
}
