import { and, desc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { llmFeedback } from "@/domains/feedback/schema";
import { flashcardDecks, flashcardReviews, flashcards, quizAttempts, quizQuestions, quizzes } from "./schema";

/** A rating at or below this is a "not this" signal the next generation should steer away from. */
const UNHELPFUL_SCORE = 2;

export type LearningGenerationContext = {
  missedQuestions: string[];
  notHelpfulExamples: string[];
};

const emptyContext = (): LearningGenerationContext => ({ missedQuestions: [], notHelpfulExamples: [] });

function includesSelectedSource(manifest: unknown, fallbackDocumentId: string, selectedIds: Set<string>): boolean {
  if (selectedIds.has(fallbackDocumentId)) return true;
  if (!Array.isArray(manifest)) return false;
  return manifest.some((source) => {
    if (!source || typeof source !== "object") return false;
    const documentId = (source as { documentId?: unknown }).documentId;
    return typeof documentId === "string" && selectedIds.has(documentId);
  });
}

function boundedPrompts(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, 6)
    .map((value) => value.slice(0, 180));
}

export async function quizGenerationContext(
  auth: AuthContext,
  documentIds: string[],
): Promise<LearningGenerationContext> {
  const selectedIds = new Set(documentIds);
  const attempts = await db
    .select({
      quizId: quizzes.id,
      documentId: quizzes.documentId,
      manifest: quizzes.sourceManifest,
      answers: quizAttempts.answers,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, and(eq(quizzes.id, quizAttempts.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .where(and(eq(quizAttempts.workspaceId, auth.workspaceId), eq(quizAttempts.userId, auth.userId)))
    .orderBy(desc(quizAttempts.createdAt))
    .limit(16);
  const relevantAttempts = attempts.filter((attempt) =>
    includesSelectedSource(attempt.manifest, attempt.documentId, selectedIds),
  );
  const feedback = await db
    .select({
      quizId: quizzes.id,
      documentId: quizzes.documentId,
      manifest: quizzes.sourceManifest,
      score: llmFeedback.score,
    })
    .from(llmFeedback)
    .innerJoin(quizzes, and(eq(quizzes.id, llmFeedback.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .where(and(eq(llmFeedback.workspaceId, auth.workspaceId), eq(llmFeedback.userId, auth.userId)))
    .orderBy(desc(llmFeedback.updatedAt))
    .limit(16);
  const relevantFeedback = feedback.filter((row) => includesSelectedSource(row.manifest, row.documentId, selectedIds));
  const quizIds = [
    ...new Set([...relevantAttempts.map((row) => row.quizId), ...relevantFeedback.map((row) => row.quizId)]),
  ];
  if (quizIds.length === 0) return emptyContext();

  const questions = await db
    .select({
      quizId: quizQuestions.quizId,
      id: quizQuestions.id,
      prompt: quizQuestions.prompt,
      answerValue: quizQuestions.answerValue,
    })
    .from(quizQuestions)
    .where(and(eq(quizQuestions.workspaceId, auth.workspaceId), inArray(quizQuestions.quizId, quizIds)))
    .limit(120);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const missedIds = new Set<string>();
  for (const attempt of relevantAttempts) {
    for (const answer of attempt.answers) {
      const question = questionById.get(answer.questionId);
      if (question && (answer.dontKnow || answer.selectedValue !== question.answerValue)) missedIds.add(question.id);
    }
  }
  const avoidedQuizIds = new Set(
    relevantFeedback.filter((row) => row.score <= UNHELPFUL_SCORE).map((row) => row.quizId),
  );
  return {
    missedQuestions: boundedPrompts(
      questions.filter((question) => missedIds.has(question.id)).map((question) => question.prompt),
    ),
    notHelpfulExamples: boundedPrompts(
      questions.filter((question) => avoidedQuizIds.has(question.quizId)).map((question) => question.prompt),
    ),
  };
}

export async function flashcardGenerationContext(
  auth: AuthContext,
  documentIds: string[],
): Promise<LearningGenerationContext> {
  const selectedIds = new Set(documentIds);
  const rows = await db
    .select({
      prompt: flashcards.prompt,
      evidence: flashcards.evidence,
      lastRating: flashcardReviews.lastRating,
      deckScore: llmFeedback.score,
    })
    .from(flashcardReviews)
    .innerJoin(
      flashcards,
      and(eq(flashcards.id, flashcardReviews.flashcardId), eq(flashcards.workspaceId, auth.workspaceId)),
    )
    .innerJoin(
      flashcardDecks,
      and(eq(flashcardDecks.id, flashcards.deckId), eq(flashcardDecks.workspaceId, auth.workspaceId)),
    )
    .leftJoin(
      llmFeedback,
      and(
        eq(llmFeedback.flashcardDeckId, flashcardDecks.id),
        eq(llmFeedback.workspaceId, auth.workspaceId),
        eq(llmFeedback.userId, auth.userId),
      ),
    )
    .where(and(eq(flashcardReviews.workspaceId, auth.workspaceId), eq(flashcardReviews.userId, auth.userId)))
    .orderBy(desc(flashcardReviews.updatedAt))
    .limit(48);
  const relevant = rows.filter((row) => selectedIds.has(row.evidence.source.documentId));
  return {
    missedQuestions: boundedPrompts(
      relevant.filter((row) => row.lastRating === "again" || row.lastRating === "hard").map((row) => row.prompt),
    ),
    notHelpfulExamples: boundedPrompts(
      relevant.filter((row) => row.deckScore !== null && row.deckScore <= UNHELPFUL_SCORE).map((row) => row.prompt),
    ),
  };
}
