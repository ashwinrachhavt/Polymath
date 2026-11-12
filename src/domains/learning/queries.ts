import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { displayTitle } from "@/lib/display-text";
import { escapeLike } from "@/lib/list-params";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { currentExtractionSql } from "@/domains/knowledge/versions";
import { buildQuizPassages, type QuizPassage } from "./quiz-passages";
import { quizHeading, sourceLabels } from "./source-labels";
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
  /** What the sitting is called: free of markdown, and rebuilt from the sources when the stored title only repeats theirs. */
  title: string;
  /** Every chosen source by display name, in manifest order; `skipped` ones were not asked about. */
  sources: Array<{ documentId: string; label: string; skipped: boolean }>;
  questions: Array<{
    id: string;
    ordinal: number;
    prompt: string;
    choices: Array<{ value: string; label: string }>;
    answerValue: string;
    explanation: string;
    evidence: QuizEvidence;
  }>;
  /** Reading order. Empty when no question's evidence could be placed in its source text. */
  passages: QuizPassage[];
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
 * a UX choice, not a scoring trust. Passages are cut here, on the server, so
 * the whole extraction text never reaches the client.
 */
export async function getQuizForSitting(auth: AuthContext, quizId: string): Promise<QuizForSitting | null> {
  const [quiz] = await db
    .select({
      id: quizzes.id,
      notebookId: quizzes.notebookId,
      documentId: quizzes.documentId,
      title: quizzes.title,
      sourceManifest: quizzes.sourceManifest,
      sourceExtractionId: quizzes.sourceExtractionId,
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

  // Rows written before quizzes read several sources carry no manifest.
  const manifest: QuizSourceSnapshot[] =
    quiz.sourceManifest.length > 0
      ? quiz.sourceManifest
      : [{ documentId: quiz.documentId, extractionId: quiz.sourceExtractionId, title: quiz.title }];
  const extractionIds = [
    ...new Set([
      ...manifest.map((source) => source.extractionId),
      ...questions.map((q) => q.evidence.source?.extractionId ?? quiz.sourceExtractionId),
    ]),
  ];
  const extractionRows = await db
    .select({
      id: documentExtractions.id,
      text: documentExtractions.text,
      documentTitle: documents.title,
      sourceUrl: documents.sourceUrl,
      createdAt: documents.createdAt,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documents.workspaceId, auth.workspaceId),
        inArray(documentExtractions.id, extractionIds),
      ),
    );
  const rowById = new Map(extractionRows.map((row) => [row.id, row]));

  const labels = sourceLabels(manifest.map((source) => ({ ...rowById.get(source.extractionId), title: source.title })));
  const labelByExtraction = new Map(manifest.map((source, i) => [source.extractionId, labels[i]]));
  const labelOf = (extractionId: string, stored: string) =>
    labelByExtraction.get(extractionId) ?? sourceLabels([{ ...rowById.get(extractionId), title: stored }])[0];
  const sources = new Map(
    extractionRows.flatMap((row) =>
      row.text === null ? [] : [[row.id, { title: labelOf(row.id, row.documentTitle), text: row.text }] as const],
    ),
  );
  const asked = manifest.flatMap((source, i) => (source.skipped ? [] : [labels[i]]));
  // Quizzes made before titles were cleaned are named "<first stored title> + N
  // more", raw markdown and all; that name is rebuilt from the sources. Any
  // other stored title was written on purpose and is only stripped of markup.
  const [first] = manifest;
  const storedTitleIsFromSources =
    quiz.title === first.title || quiz.title === `${first.title} + ${manifest.length - 1} more`.slice(0, 200);
  return {
    id: quiz.id,
    notebookId: quiz.notebookId,
    documentId: quiz.documentId,
    title: storedTitleIsFromSources ? quizHeading(asked.length > 0 ? asked : labels) : displayTitle(quiz.title),
    sources: manifest.map((source, i) => ({
      documentId: source.documentId,
      label: labels[i],
      skipped: source.skipped === true,
    })),
    questions: questions.map((question) => {
      const { source } = question.evidence;
      if (!source) return question;
      const title = labelOf(source.extractionId, source.title);
      return { ...question, evidence: { ...question.evidence, source: { ...source, title } } };
    }),
    passages: buildQuizPassages(questions, sources, quiz.sourceExtractionId),
  };
}
