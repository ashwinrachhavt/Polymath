import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { todayIn } from "@/domains/daybook/queries";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { flashcardIsDue, ratingForAnswer, recordReview } from "./review-schedule";
import {
  chooseSession,
  DEFAULT_STUDY_MINUTES,
  estimatedSeconds,
  MISSION_WINDOW_DAYS,
  type MissionDeadline,
  type StudyCandidate,
} from "./study-queue";
import {
  conceptLinks,
  flashcardDecks,
  flashcardReviews,
  flashcards,
  missionConcepts,
  missions,
  quizQuestions,
  quizzes,
  type QuizChoice,
} from "./schema";

/*
 * Study: the day's due items from every source and mission, as one short
 * session. What is due: a flashcard that was never rated or whose review time
 * has come, and a quiz question that has been answered before and whose review
 * time has come (a question is scheduled by its first sitting, so unseen
 * questions are not "due"). Both kinds read one schedule (review-schedule.ts).
 * How the session is chosen and ordered is study-queue.ts.
 *
 * A quiz question is sent to the browser without its answer or explanation;
 * `answerStudyQuestion` grades on the server and only then reveals them.
 */

/** The most due items of each kind read to choose a session from. */
const CANDIDATE_LIMIT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StudyItem =
  | { kind: "flashcard"; id: string; prompt: string; answer: string; source: string; quote: string }
  | { kind: "quiz_question"; id: string; prompt: string; choices: QuizChoice[]; source: string };

export type StudyOutlook = {
  /** Items due right now, in every source (a session may take fewer). */
  dueNow: number;
  /** Items whose review time falls on tomorrow, in the learner's own day. */
  tomorrow: number;
  /** The nearest dated mission still ahead, when there is one. */
  mission: { title: string; daysLeft: number } | null;
};

export type StudyPlan = StudyOutlook & { items: StudyItem[]; minutes: number };

type Candidate = StudyCandidate & { item: StudyItem };

async function dueFlashcards(auth: AuthContext, now: Date): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: flashcards.id,
      prompt: flashcards.prompt,
      answer: flashcards.answer,
      evidence: flashcards.evidence,
      dueAt: flashcardReviews.dueAt,
    })
    .from(flashcards)
    .innerJoin(
      flashcardDecks,
      and(eq(flashcardDecks.id, flashcards.deckId), eq(flashcardDecks.workspaceId, auth.workspaceId)),
    )
    .leftJoin(
      flashcardReviews,
      and(
        eq(flashcardReviews.flashcardId, flashcards.id),
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.userId, auth.userId),
      ),
    )
    .where(and(eq(flashcards.workspaceId, auth.workspaceId), flashcardIsDue(now)))
    .orderBy(sql`coalesce(${flashcardReviews.dueAt}, now())`, asc(flashcards.createdAt))
    .limit(CANDIDATE_LIMIT);
  return rows.map((row) => ({
    kind: "flashcard",
    id: row.id,
    sourceKey: row.evidence.source.documentId,
    dueAt: row.dueAt ?? now,
    conceptIds: [],
    item: {
      kind: "flashcard",
      id: row.id,
      prompt: row.prompt,
      answer: row.answer,
      source: row.evidence.source.title,
      quote: row.evidence.quote,
    },
  }));
}

async function dueQuizQuestions(auth: AuthContext, now: Date): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: quizQuestions.id,
      prompt: quizQuestions.prompt,
      choices: quizQuestions.choices,
      evidence: quizQuestions.evidence,
      documentId: quizzes.documentId,
      quizTitle: quizzes.title,
      dueAt: flashcardReviews.dueAt,
    })
    .from(flashcardReviews)
    .innerJoin(
      quizQuestions,
      and(eq(quizQuestions.id, flashcardReviews.quizQuestionId), eq(quizQuestions.workspaceId, auth.workspaceId)),
    )
    .innerJoin(quizzes, and(eq(quizzes.id, quizQuestions.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .where(
      and(
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.userId, auth.userId),
        isNotNull(flashcardReviews.quizQuestionId),
        lte(flashcardReviews.dueAt, now),
        eq(quizzes.status, "ready"),
      ),
    )
    .orderBy(asc(flashcardReviews.dueAt))
    .limit(CANDIDATE_LIMIT);
  return rows.map((row) => ({
    kind: "quiz_question",
    id: row.id,
    sourceKey: row.evidence.source?.documentId ?? row.documentId,
    dueAt: row.dueAt,
    conceptIds: [],
    item: {
      kind: "quiz_question",
      id: row.id,
      prompt: row.prompt,
      choices: row.choices,
      source: row.evidence.source?.title ?? row.quizTitle,
    },
  }));
}

/** Fills in which concepts each candidate is about, so a mission can claim it. */
async function withConcepts(auth: AuthContext, candidates: Candidate[]): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;
  const cardIds = candidates.filter((c) => c.kind === "flashcard").map((c) => c.id);
  const questionIds = candidates.filter((c) => c.kind === "quiz_question").map((c) => c.id);
  const links = await db
    .select({
      flashcardId: conceptLinks.flashcardId,
      quizQuestionId: conceptLinks.quizQuestionId,
      conceptId: conceptLinks.conceptId,
    })
    .from(conceptLinks)
    .where(
      and(
        eq(conceptLinks.workspaceId, auth.workspaceId),
        sql`(${cardIds.length ? inArray(conceptLinks.flashcardId, cardIds) : sql`false`} or ${
          questionIds.length ? inArray(conceptLinks.quizQuestionId, questionIds) : sql`false`
        })`,
      ),
    );
  const byItem = new Map<string, string[]>();
  for (const link of links) {
    const key = link.flashcardId ?? link.quizQuestionId!;
    byItem.set(key, [...(byItem.get(key) ?? []), link.conceptId]);
  }
  return candidates.map((c) => ({ ...c, conceptIds: byItem.get(c.id) ?? [] }));
}

/** Active missions with a date still ahead (or today), with the concepts each one is about. */
async function datedMissions(auth: AuthContext, today: string): Promise<Array<MissionDeadline & { title: string }>> {
  const rows = await db
    .select({
      id: missions.id,
      goal: missions.goal,
      role: missions.role,
      dueOn: missions.dueOn,
      conceptId: missionConcepts.conceptId,
    })
    .from(missions)
    .leftJoin(
      missionConcepts,
      and(eq(missionConcepts.missionId, missions.id), eq(missionConcepts.workspaceId, auth.workspaceId)),
    )
    .where(
      and(
        eq(missions.workspaceId, auth.workspaceId),
        eq(missions.status, "active"),
        isNotNull(missions.dueOn),
        sql`${missions.dueOn} >= ${today}::date`,
      ),
    );
  const byMission = new Map<string, MissionDeadline & { title: string }>();
  for (const row of rows) {
    const entry = byMission.get(row.id) ?? {
      title: row.role?.trim() || row.goal,
      daysLeft: Math.round((Date.parse(row.dueOn!) - Date.parse(today)) / DAY_MS),
      conceptIds: new Set<string>(),
    };
    if (row.conceptId) (entry.conceptIds as Set<string>).add(row.conceptId);
    byMission.set(row.id, entry);
  }
  return [...byMission.values()].sort((a, b) => a.daysLeft - b.daysLeft);
}

async function countOutlook(auth: AuthContext, nowDate: Date): Promise<{ dueNow: number; tomorrow: number }> {
  // A raw template takes the instant as text; drizzle's typed helpers handle Dates themselves.
  const now = nowDate.toISOString();
  const [row] = (await db.execute(sql`
    select
      (select count(*)::int from flashcard_reviews r
        where r.workspace_id = ${auth.workspaceId} and r.user_id = ${auth.userId} and r.due_at <= ${now}::timestamptz)
      + (select count(*)::int from flashcards f
          where f.workspace_id = ${auth.workspaceId}
            and not exists (select 1 from flashcard_reviews r
              where r.flashcard_id = f.id and r.user_id = ${auth.userId} and r.workspace_id = ${auth.workspaceId}))
      as due_now,
      (select count(*)::int from flashcard_reviews r
        where r.workspace_id = ${auth.workspaceId} and r.user_id = ${auth.userId}
          and (r.due_at at time zone tz.name)::date = (${now}::timestamptz at time zone tz.name)::date + 1)
      as tomorrow
    from (select coalesce(
      (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}), 'UTC'
    ) as name) tz
  `)) as unknown as Array<{ due_now: number; tomorrow: number }>;
  return { dueNow: row?.due_now ?? 0, tomorrow: row?.tomorrow ?? 0 };
}

/** What is due now and tomorrow, and the nearest mission date: the summary after a session, and Today's card. */
export async function getStudyOutlook(auth: AuthContext, now: Date = new Date()): Promise<StudyOutlook> {
  const [counts, ahead] = await Promise.all([
    countOutlook(auth, now),
    todayIn(auth).then((today) => datedMissions(auth, today)),
  ]);
  const nearest = ahead[0];
  return { ...counts, mission: nearest ? { title: nearest.title, daysLeft: nearest.daysLeft } : null };
}

/** The session for the day: due items from every source, chosen to fit the time and interleaved. */
export async function getStudyPlan(
  auth: AuthContext,
  input: { minutes?: number; now?: Date } = {},
): Promise<StudyPlan> {
  const now = input.now ?? new Date();
  const [cards, questions, ahead, outlook] = await Promise.all([
    dueFlashcards(auth, now),
    dueQuizQuestions(auth, now),
    todayIn(auth).then((today) => datedMissions(auth, today)),
    countOutlook(auth, now),
  ]);
  const candidates = await withConcepts(auth, [...cards, ...questions]);
  const chosen = chooseSession(candidates, {
    missions: ahead.filter((mission) => mission.daysLeft <= MISSION_WINDOW_DAYS),
    now,
    minutes: input.minutes ?? DEFAULT_STUDY_MINUTES,
  });
  const nearest = ahead[0];
  return {
    ...outlook,
    mission: nearest ? { title: nearest.title, daysLeft: nearest.daysLeft } : null,
    items: chosen.map((c) => c.item),
    minutes: Math.max(1, Math.round(estimatedSeconds(chosen) / 60)),
  };
}

export class StudyError extends Error {
  constructor(
    public readonly code: "question_not_found" | "invalid_answer",
    message: string,
  ) {
    super(message);
    this.name = "StudyError";
  }
}

export type StudyAnswerResult = {
  correct: boolean;
  /** The `value` of the right choice, revealed now that the answer is in. */
  answerValue: string;
  explanation: string;
  quote: string;
  dueAt: Date;
};

/**
 * Grade one answered quiz question on the server and schedule it: a right
 * answer comes back later, a wrong one or "I don't know" (`selectedValue`
 * null) in minutes. The same schedule a flashcard rating writes.
 */
export async function answerStudyQuestion(
  auth: AuthContext,
  input: { questionId: string; selectedValue: string | null },
): Promise<StudyAnswerResult> {
  const [question] = await db
    .select({
      id: quizQuestions.id,
      choices: quizQuestions.choices,
      answerValue: quizQuestions.answerValue,
      explanation: quizQuestions.explanation,
      evidence: quizQuestions.evidence,
      quizStatus: quizzes.status,
    })
    .from(quizQuestions)
    .innerJoin(quizzes, and(eq(quizzes.id, quizQuestions.quizId), eq(quizzes.workspaceId, auth.workspaceId)))
    .where(and(eq(quizQuestions.id, input.questionId), eq(quizQuestions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!question || question.quizStatus !== "ready") {
    throw new StudyError("question_not_found", "That question is not available.");
  }
  if (input.selectedValue !== null && !question.choices.some((choice) => choice.value === input.selectedValue)) {
    throw new StudyError("invalid_answer", "That choice is not one of the question's answers.");
  }
  const correct = input.selectedValue !== null && input.selectedValue === question.answerValue;
  const rating = ratingForAnswer(correct);
  const { dueAt } = await withTransaction(async (tx) => {
    const review = await recordReview(tx, auth, { quizQuestionId: question.id }, rating);
    await recordAudit(
      auth,
      {
        action: "learning.quiz_question_reviewed",
        subjectType: "quiz_question",
        subjectId: question.id,
        summary: correct ? "Answered a study question correctly" : "Missed a study question",
        metadata: { correct, intervalDays: review.intervalDays },
      },
      tx,
    );
    return review;
  });
  return {
    correct,
    answerValue: question.answerValue,
    explanation: question.explanation,
    quote: question.evidence.quote,
    dueAt,
  };
}
