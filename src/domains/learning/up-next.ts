import { and, desc, eq, gt, gte, isNotNull, notExists, sql } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { auditEvents } from "@/domains/audit/schema";
import { getPreferences, isValidTimezone } from "@/domains/identity/preferences";
import type { AuthContext } from "@/domains/identity/resolve";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { oldestOpenDisagreement } from "@/domains/knowledge/tidy";
import { db } from "@/lib/db";
import { shiftDateKey, todayKeyInTimezone } from "@/lib/local-date";
import { countDueFlashcards, getFlashcardDueQueue } from "./flashcards";
import { quizAttempts, quizzes } from "./schema";

/*
 * Home's Up next: the one place to continue learning, and whether the habit
 * is holding. Due cards come first because they decay; two ideas that
 * disagree are the next lesson; a quiz the user has never sat waits behind
 * them.
 */

export type UpNext = {
  /** Every card due for this user now, across all decks. */
  dueCards: number;
  /** The deck holding the card that has waited longest. */
  firstDue: { notebookId: string; deckId: string } | null;
  /** The newest Notebook quiz this user has never sat, linked inside its Notebook. */
  quizWaiting: { quizId: string; title: string; href: string } | null;
  /** Consecutive local days with learning, ending today or yesterday; 0 when broken. */
  streakDays: number;
  /** The open disagreement between two ideas that has waited longest, with how many are open. */
  disagreement: { findingId: string; firstTitle: string; secondTitle: string; open: number } | null;
};

export async function getUpNext(auth: AuthContext): Promise<UpNext> {
  const [dueCards, [firstCard], quiz, streakDays, disagreement] = await Promise.all([
    countDueFlashcards(auth),
    getFlashcardDueQueue(auth, 1),
    quizWaiting(auth),
    learningStreakDays(auth),
    oldestOpenDisagreement(auth),
  ]);
  return {
    dueCards,
    firstDue: firstCard ? { notebookId: firstCard.notebookId, deckId: firstCard.deckId } : null,
    quizWaiting: quiz,
    streakDays,
    disagreement,
  };
}

/*
 * The newest ready quiz this user has never attempted, among the quizzes the
 * Learn list shows (a document's latest ready quiz; an older generation is
 * superseded). Only a quiz made in a Notebook qualifies, and only while that
 * Notebook still holds every source the quiz pins: the Notebook page opens a
 * quiz on exactly that condition, so Continue never lands on a Notebook that
 * hides it. A quiz made outside any Notebook stays on the Learn list.
 */
async function quizWaiting(auth: AuthContext): Promise<UpNext["quizWaiting"]> {
  const newer = alias(quizzes, "newer_quiz");
  const [quiz] = await db
    .select({
      id: quizzes.id,
      title: quizzes.title,
      notebookId: quizzes.notebookId,
      documentId: quizzes.documentId,
      sourceManifest: quizzes.sourceManifest,
    })
    .from(quizzes)
    .where(
      and(
        eq(quizzes.workspaceId, auth.workspaceId),
        eq(quizzes.status, "ready"),
        isNotNull(quizzes.notebookId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(quizAttempts)
            .where(
              and(
                eq(quizAttempts.workspaceId, auth.workspaceId),
                eq(quizAttempts.quizId, quizzes.id),
                eq(quizAttempts.userId, auth.userId),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(newer)
            .where(
              and(
                eq(newer.workspaceId, auth.workspaceId),
                eq(newer.documentId, quizzes.documentId),
                eq(newer.status, "ready"),
                gt(newer.createdAt, quizzes.createdAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(quizzes.createdAt), desc(quizzes.id))
    .limit(1);
  if (!quiz?.notebookId) return null;

  const held = await projectDocumentIds(auth, quiz.notebookId);
  const pinned =
    quiz.sourceManifest.length > 0 ? quiz.sourceManifest.map((source) => source.documentId) : [quiz.documentId];
  if (!held || !pinned.every((id) => held.includes(id))) return null;
  return { quizId: quiz.id, title: quiz.title, href: `/projects/${quiz.notebookId}/notebook?quiz=${quiz.id}` };
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
 * same transaction as the rating. The partial index
 * audit_events_flashcard_review_idx serves exactly this read.
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
