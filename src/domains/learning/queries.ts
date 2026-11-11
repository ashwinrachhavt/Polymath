import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { documents } from "@/domains/knowledge/schema";
import { currentExtractionSql } from "@/domains/knowledge/versions";
import { quizAttempts, quizQuestions, quizzes, type QuizEvidence, type QuizSourceSnapshot } from "./schema";

/*
 * Every read the Learn surface needs, so UI code never joins across domains.
 * The library's per-document aggregates describe the quiz the user can act
 * on now - the latest ready quiz - not the history of superseded
 * generations: "best score" and "last attempted" on a quiz you cannot retake
 * would be a number that lies. The one exception is the newest generation's
 * failure: a failed regeneration after a ready quiz is news the library must
 * show, not swallow.
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
  /** The document's newest quiz event failed: its authored, owner-facing reason. */
  lastFailure: string | null;
};

export type QuizForSitting = {
  id: string;
  notebookId: string | null;
  documentId: string;
  title: string;
  sourceManifest: QuizSourceSnapshot[];
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

/**
 * Library documents a learner can pick as flashcard or quiz sources, newest
 * first, matched on title. `ready` is false while a document is still being
 * read: generation needs its text, so the picker shows it but cannot use it.
 */
export async function searchLearningDocuments(
  auth: AuthContext,
  input: { query?: string; limit: number },
): Promise<Array<{ id: string; title: string; ready: boolean }>> {
  const query = input.query?.trim();
  return db
    .select({
      id: documents.id,
      title: documents.title,
      ready: sql<boolean>`coalesce(${currentExtractionSql("status")} = 'succeeded', false)`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, auth.workspaceId),
        query ? ilike(documents.title, `%${escapeLike(query)}%`) : undefined,
      ),
    )
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(input.limit);
}

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
      status: quizzes.status,
      error: quizzes.error,
    })
    .from(quizzes)
    .where(eq(quizzes.workspaceId, auth.workspaceId))
    .orderBy(desc(quizzes.createdAt));
  const latestByDocument = latestReadyQuizByDocument(quizRows.filter((row) => row.status === "ready"));
  // First sight of a document across ALL generations - ready or failed - so
  // a failed regeneration after a ready quiz still reaches the library.
  const latestEventByDocument = new Map<string, (typeof quizRows)[number]>();
  for (const row of quizRows) {
    if (!latestEventByDocument.has(row.documentId)) latestEventByDocument.set(row.documentId, row);
  }
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
    const latestEvent = latestEventByDocument.get(doc.documentId);
    return {
      documentId: doc.documentId,
      title: doc.title,
      quizzable: doc.quizzable,
      quizId: quiz?.id ?? null,
      questionCount: quiz?.questionCount ?? null,
      bestCorrect: attempts?.bestCorrect ?? null,
      lastAttemptedAt: attempts?.lastAttemptedAt ?? null,
      lastFailure: latestEvent?.status === "failed" ? (latestEvent.error ?? "The last generation failed.") : null,
    };
  });
}

/**
 * The quiz a sitting runs against, with its questions in ordinal order and
 * everything instant feedback needs: values, explanations, evidence. The
 * server re-grades on completion, so revealing answerValue to the runner is
 * a UX choice, not a scoring trust.
 */
export async function getQuizForSitting(auth: AuthContext, quizId: string): Promise<QuizForSitting | null> {
  const [quiz] = await db
    .select({
      id: quizzes.id,
      notebookId: quizzes.notebookId,
      documentId: quizzes.documentId,
      title: quizzes.title,
      sourceManifest: quizzes.sourceManifest,
    })
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
