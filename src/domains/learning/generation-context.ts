import { and, desc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import {
  flashcardDecks,
  flashcardReviews,
  flashcards,
  learningArtifactFeedback,
  quizAttempts,
  quizQuestions,
  quizzes,
} from "./schema";

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
      rating: learningArtifactFeedback.rating,
    })
    .from(learningArtifactFeedback)
    .innerJoin(quizzes, and(eq(quizzes.id, learningArtifactFeedback.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .where(
      and(eq(learningArtifactFeedback.workspaceId, auth.workspaceId), eq(learningArtifactFeedback.userId, auth.userId)),
    )
    .orderBy(desc(learningArtifactFeedback.updatedAt))
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
    relevantFeedback.filter((row) => row.rating === "not_helpful").map((row) => row.quizId),
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
      deckRating: learningArtifactFeedback.rating,
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
      learningArtifactFeedback,
      and(
        eq(learningArtifactFeedback.flashcardDeckId, flashcardDecks.id),
        eq(learningArtifactFeedback.workspaceId, auth.workspaceId),
        eq(learningArtifactFeedback.userId, auth.userId),
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
      relevant.filter((row) => row.deckRating === "not_helpful").map((row) => row.prompt),
    ),
  };
}
