import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { displayTitle } from "@/lib/display-text";
import { flashcardDecks, flashcardReviews, flashcards, quizAttempts, quizzes } from "./schema";

/*
 * Learn's history: one row per flashcard stack (deck) and one per quiz, so the
 * page is a list of things to reopen, not a row per card or per concept. Each
 * stack carries how much of it is due, how far it has been learned and when
 * it was last studied; each quiz carries its scores. Both are the reading
 * learner's own: reviews and attempts are private to them.
 */

/** A card counts as "remembered" once its interval has grown to a week; "seen" is any review at all. */
const REMEMBERED_INTERVAL_DAYS = 7;
const HISTORY_LIMIT = 100;

export type FlashcardStack = {
  deckId: string;
  /** Null for a deck made from picked sources; reviewed on Learn. */
  notebookId: string | null;
  title: string;
  /** Source titles, markdown stripped, in manifest order. */
  sources: string[];
  cardCount: number;
  /** Cards never rated or whose review time has come. */
  dueCount: number;
  /** Cards rated at least once. */
  seenCount: number;
  /** Cards whose interval has reached REMEMBERED_INTERVAL_DAYS. */
  rememberedCount: number;
  lastStudiedAt: Date | null;
  createdAt: Date;
};

/** Flashcard stacks, the most recently studied (or made) first. */
export async function listFlashcardStacks(auth: AuthContext): Promise<FlashcardStack[]> {
  const rows = await db
    .select({
      deckId: flashcardDecks.id,
      notebookId: flashcardDecks.notebookId,
      title: flashcardDecks.title,
      sourceManifest: flashcardDecks.sourceManifest,
      createdAt: flashcardDecks.createdAt,
      cardCount: sql<number>`count(${flashcards.id})::int`,
      dueCount: sql<number>`count(${flashcards.id}) filter (where ${flashcardReviews.id} is null or ${flashcardReviews.dueAt} <= now())::int`,
      seenCount: sql<number>`count(${flashcardReviews.id})::int`,
      rememberedCount: sql<number>`count(${flashcardReviews.id}) filter (where ${flashcardReviews.intervalDays} >= ${REMEMBERED_INTERVAL_DAYS})::int`,
      lastStudiedAt: sql<Date | null>`max(${flashcardReviews.updatedAt})`,
    })
    .from(flashcardDecks)
    .innerJoin(flashcards, and(eq(flashcards.deckId, flashcardDecks.id), eq(flashcards.workspaceId, auth.workspaceId)))
    .leftJoin(
      flashcardReviews,
      and(
        eq(flashcardReviews.flashcardId, flashcards.id),
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.userId, auth.userId),
      ),
    )
    .where(eq(flashcardDecks.workspaceId, auth.workspaceId))
    .groupBy(flashcardDecks.id)
    .orderBy(
      desc(sql`coalesce(max(${flashcardReviews.updatedAt}), ${flashcardDecks.createdAt})`),
      desc(flashcardDecks.id),
    )
    .limit(HISTORY_LIMIT);
  return rows.map(({ sourceManifest, lastStudiedAt, ...row }) => ({
    ...row,
    title: displayTitle(row.title),
    sources: sourceManifest.map((source) => displayTitle(source.title)),
    // A max() over a timestamp column comes back as text through a raw fragment.
    lastStudiedAt: lastStudiedAt ? new Date(lastStudiedAt) : null,
  }));
}

export type QuizHistoryRow = {
  quizId: string;
  title: string;
  questionCount: number;
  createdAt: Date;
  /** Sittings by this learner. */
  attempts: number;
  /** Correct answers out of questionCount; null until the first sitting. */
  latestCorrect: number | null;
  bestCorrect: number | null;
  latestAttemptedAt: Date | null;
};

/** Every ready quiz with this learner's scores, the most recently sat (or made) first. */
export async function listQuizHistory(auth: AuthContext): Promise<QuizHistoryRow[]> {
  const rows = await db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      questionCount: quizzes.questionCount,
      createdAt: quizzes.createdAt,
      attempts: sql<number>`count(${quizAttempts.id})::int`,
      bestCorrect: sql<number | null>`max(${quizAttempts.correctCount})`,
      latestCorrect: sql<
        number | null
      >`(array_agg(${quizAttempts.correctCount} order by ${quizAttempts.createdAt} desc))[1]`,
      latestAttemptedAt: sql<Date | null>`max(${quizAttempts.createdAt})`,
    })
    .from(quizzes)
    .leftJoin(
      quizAttempts,
      and(
        eq(quizAttempts.quizId, quizzes.id),
        eq(quizAttempts.workspaceId, auth.workspaceId),
        eq(quizAttempts.userId, auth.userId),
      ),
    )
    .where(and(eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.status, "ready")))
    .groupBy(quizzes.id)
    .orderBy(desc(sql`coalesce(max(${quizAttempts.createdAt}), ${quizzes.createdAt})`), desc(quizzes.id))
    .limit(HISTORY_LIMIT);
  return rows.map((row) => ({
    ...row,
    title: displayTitle(row.title),
    latestAttemptedAt: row.latestAttemptedAt ? new Date(row.latestAttemptedAt) : null,
  }));
}
