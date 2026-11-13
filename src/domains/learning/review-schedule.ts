import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { TxDrizzle } from "@/lib/db-transaction";
import { flashcardReviews } from "./schema";

/*
 * The one scheduler. Every reviewable item, a flashcard or a quiz question,
 * has at most one row per learner in `flashcard_reviews`, and this file is the
 * only place a rating becomes a due date. It is an SM-2 variant: a lapse
 * ("again") returns in ten minutes with a lower ease; otherwise the interval
 * grows by the ease factor, from 1 day to 3 days to interval x ease.
 */

export type ReviewRating = "again" | "hard" | "good" | "easy";

/** What a rating is recorded against: exactly one item. */
export type ReviewSubject = { flashcardId: string } | { quizQuestionId: string };

type Schedule = { intervalDays: number; easeHundredths: number; repetitions: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const LAPSE_RETURN_MS = 10 * 60 * 1000;
const MIN_EASE = 130;
const MAX_EASE = 350;
const STARTING_EASE = 250;

/** Pure: the next schedule and due time from the previous schedule (none for a first review) and a rating. */
function nextSchedule(previous: Schedule | undefined, rating: ReviewRating, now: Date): Schedule & { dueAt: Date } {
  const ease = previous?.easeHundredths ?? STARTING_EASE;
  let intervalDays = previous?.intervalDays ?? 0;
  let easeHundredths = ease;
  let repetitions = previous?.repetitions ?? 0;
  let delayMs: number;

  if (rating === "again") {
    intervalDays = 0;
    repetitions = 0;
    easeHundredths = Math.max(MIN_EASE, ease - 20);
    delayMs = LAPSE_RETURN_MS;
  } else if (rating === "hard") {
    intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    repetitions += 1;
    easeHundredths = Math.max(MIN_EASE, ease - 15);
    delayMs = intervalDays * DAY_MS;
  } else if (rating === "easy") {
    intervalDays = repetitions === 0 ? 4 : Math.max(4, Math.round(intervalDays * (ease / 100) * 1.3));
    repetitions += 1;
    easeHundredths = Math.min(MAX_EASE, ease + 15);
    delayMs = intervalDays * DAY_MS;
  } else {
    intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 3 : Math.max(1, Math.round(intervalDays * (ease / 100)));
    repetitions += 1;
    delayMs = intervalDays * DAY_MS;
  }
  return { intervalDays, easeHundredths, repetitions, dueAt: new Date(now.getTime() + delayMs) };
}

/** A graded multiple-choice answer carries no "how hard was it": right is Good, wrong or "I don't know" is Again. */
export function ratingForAnswer(correct: boolean): ReviewRating {
  return correct ? "good" : "again";
}

/**
 * Record one rating for the learner: read the current schedule, step it, and
 * upsert, inside the caller's transaction. Replaying a rating steps the
 * schedule again; callers that can be retried guard with their own key.
 */
export async function recordReview(
  tx: TxDrizzle,
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  subject: ReviewSubject,
  rating: ReviewRating,
  now: Date = new Date(),
): Promise<{ dueAt: Date; intervalDays: number }> {
  const flashcardId = "flashcardId" in subject ? subject.flashcardId : null;
  const quizQuestionId = "quizQuestionId" in subject ? subject.quizQuestionId : null;
  const item = flashcardId
    ? eq(flashcardReviews.flashcardId, flashcardId)
    : eq(flashcardReviews.quizQuestionId, quizQuestionId!);
  const [previous] = await tx
    .select({
      intervalDays: flashcardReviews.intervalDays,
      easeHundredths: flashcardReviews.easeHundredths,
      repetitions: flashcardReviews.repetitions,
    })
    .from(flashcardReviews)
    .where(and(eq(flashcardReviews.workspaceId, auth.workspaceId), eq(flashcardReviews.userId, auth.userId), item))
    .limit(1);
  const step = nextSchedule(previous, rating, now);
  const { dueAt, ...schedule } = step;
  await tx
    .insert(flashcardReviews)
    .values({
      workspaceId: auth.workspaceId,
      flashcardId,
      quizQuestionId,
      userId: auth.userId,
      dueAt,
      ...schedule,
      lastRating: rating,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoUpdate({
      target: flashcardId
        ? [flashcardReviews.workspaceId, flashcardReviews.flashcardId, flashcardReviews.userId]
        : [flashcardReviews.workspaceId, flashcardReviews.quizQuestionId, flashcardReviews.userId],
      set: { dueAt, ...schedule, lastRating: rating, updatedBy: auth.userId, updatedAt: now },
    });
  return { dueAt, intervalDays: schedule.intervalDays };
}

/**
 * What "due" means for a flashcard joined to its learner's review row: never
 * reviewed, or the review time has come. A quiz question is not due until it
 * has been answered once, so it joins its review row and tests the time alone.
 */
export function flashcardIsDue(now: Date) {
  return or(isNull(flashcardReviews.id), lte(flashcardReviews.dueAt, now));
}
