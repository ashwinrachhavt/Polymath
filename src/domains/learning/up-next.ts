import { and, eq, gte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { auditEvents } from "@/domains/audit/schema";
import { getPreferences, isValidTimezone } from "@/domains/identity/preferences";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { shiftDateKey, todayKeyInTimezone } from "@/lib/local-date";
import { countDueFlashcards, getFlashcardDueQueue } from "./flashcards";
import { getLearnLibrary } from "./queries";
import { quizAttempts } from "./schema";

/*
 * Home's Up next: the one place to continue learning, and whether the habit
 * is holding. Due cards come first because they decay; a quiz the user has
 * never sat waits behind them.
 */

export type UpNext = {
  /** Every card due for this user now, across all decks. */
  dueCards: number;
  /** The deck holding the card that has waited longest. */
  firstDue: { notebookId: string; deckId: string } | null;
  /** The newest document's ready quiz this user has never attempted. */
  quizWaiting: { quizId: string; title: string; href: string } | null;
  /** Consecutive local days with learning, ending today or yesterday; 0 when broken. */
  streakDays: number;
};

export async function getUpNext(auth: AuthContext): Promise<UpNext> {
  const [dueCards, [firstCard], library, streakDays] = await Promise.all([
    countDueFlashcards(auth),
    getFlashcardDueQueue(auth, 1),
    getLearnLibrary(auth),
    learningStreakDays(auth),
  ]);
  const quiz = library.find((row) => row.quizId !== null && row.bestCorrect === null);
  return {
    dueCards,
    firstDue: firstCard ? { notebookId: firstCard.notebookId, deckId: firstCard.deckId } : null,
    quizWaiting: quiz?.quizId ? { quizId: quiz.quizId, title: quiz.title, href: `/learn/${quiz.documentId}` } : null,
    streakDays,
  };
}

/*
 * A streak older than this window reads as the window: one bounded scan on
 * every home render instead of the user's whole history.
 */
const STREAK_LOOKBACK_DAYS = 366;

/*
 * A day of learning is a day with a flashcard review or a quiz attempt, in the
 * user's own timezone. Ratings overwrite the card's schedule row, so the review
 * history is the audit trail: rateFlashcard writes one row per rating in the
 * same transaction as the rating.
 */
async function learningStreakDays(auth: AuthContext): Promise<number> {
  const { timezone } = await getPreferences(auth);
  const zone = isValidTimezone(timezone) ? timezone : "UTC";
  const since = new Date(Date.now() - STREAK_LOOKBACK_DAYS * 86_400_000);
  const localDay = (at: AnyPgColumn) => sql<string>`to_char((${at} at time zone ${zone})::date, 'YYYY-MM-DD')`;

  const [reviewDays, attemptDays] = await Promise.all([
    db
      .selectDistinct({ day: localDay(auditEvents.createdAt) })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.actorId, auth.userId),
          eq(auditEvents.action, "learning.flashcard_reviewed"),
          gte(auditEvents.createdAt, since),
        ),
      ),
    db
      .selectDistinct({ day: localDay(quizAttempts.createdAt) })
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.workspaceId, auth.workspaceId),
          eq(quizAttempts.userId, auth.userId),
          gte(quizAttempts.createdAt, since),
        ),
      ),
  ]);
  const days = new Set([...reviewDays, ...attemptDays].map((row) => row.day));

  // Today still counts as open: a streak through yesterday stands until today ends.
  const today = todayKeyInTimezone(zone);
  let day = days.has(today) ? today : shiftDateKey(today, -1);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = shiftDateKey(day, -1);
  }
  return streak;
}
