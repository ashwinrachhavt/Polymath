import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { concepts } from "@/domains/knowledge/schema";
import {
  conceptLinks,
  flashcardDecks,
  flashcardReviews,
  flashcards,
  missionConcepts,
  missions,
  quizQuestions,
  quizzes,
} from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { seedReadDocument } from "../helpers/learning-fixtures";

/*
 * Study on real Postgres: one schedule for cards and quiz questions, what is
 * due, the interleaved session and the tomorrow count. Time moves through the
 * `now` the plan takes, never by editing rows.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof makeTestDb>["db"] | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { completeQuizAttempt } from "@/domains/learning/commands";
import { rateFlashcard } from "@/domains/learning/flashcards";
import { answerStudyQuestion, getStudyOutlook, getStudyPlan, StudyError } from "@/domains/learning/study";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

type Auth = ReturnType<typeof ownerAuth>;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

async function seedAuth(slug: string): Promise<Auth> {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `${slug}-${Date.now()}-${Math.random()}`);
  return ownerAuth(userId, workspaceId);
}

async function seedCards(auth: Auth, input: { documentId: string; title: string; count: number; prefix: string }) {
  const [deck] = await holder
    .db!.insert(flashcardDecks)
    .values({
      workspaceId: auth.workspaceId,
      title: input.title,
      sourceManifest: [],
      generationKey: crypto.randomUUID(),
      model: "fixture",
      promptVersion: "fixture",
    })
    .returning({ id: flashcardDecks.id });
  return holder
    .db!.insert(flashcards)
    .values(
      Array.from({ length: input.count }, (_, ordinal) => ({
        workspaceId: auth.workspaceId,
        deckId: deck!.id,
        ordinal,
        prompt: `${input.prefix} card ${ordinal}`,
        answer: `${input.prefix} answer ${ordinal}`,
        evidence: {
          quote: "the quote",
          startOffset: 0,
          endOffset: 9,
          source: { documentId: input.documentId, extractionId: crypto.randomUUID(), title: input.title },
        },
      })),
    )
    .returning({ id: flashcards.id });
}

async function seedQuiz(auth: Auth, questions: number) {
  const { documentId, extractionId } = await seedReadDocument(holder.db!, auth, "Source text.", "Quiz source");
  const [quiz] = await holder
    .db!.insert(quizzes)
    .values({
      workspaceId: auth.workspaceId,
      documentId,
      sourceExtractionId: extractionId,
      title: "Fixture quiz",
      status: "ready",
      questionCount: questions,
    })
    .returning({ id: quizzes.id });
  const rows = await holder
    .db!.insert(quizQuestions)
    .values(
      Array.from({ length: questions }, (_, ordinal) => ({
        workspaceId: auth.workspaceId,
        quizId: quiz!.id,
        ordinal,
        prompt: `Question ${ordinal}`,
        choices: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
        answerValue: "a",
        explanation: "Because alpha.",
        evidence: { quote: "Source text.", startOffset: 0, endOffset: 12 },
      })),
    )
    .returning({ id: quizQuestions.id });
  return { quizId: quiz!.id, documentId, questionIds: rows.map((r) => r.id) };
}

const reviewOf = async (auth: Auth, where: { quizQuestionId?: string; flashcardId?: string }) => {
  const [row] = await holder
    .db!.select()
    .from(flashcardReviews)
    .where(
      and(
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        where.quizQuestionId
          ? eq(flashcardReviews.quizQuestionId, where.quizQuestionId)
          : eq(flashcardReviews.flashcardId, where.flashcardId!),
      ),
    );
  return row;
};

suite("study session", { timeout: 60_000 }, () => {
  it("a quiz sitting schedules every question: a miss returns in minutes, a right answer in a day", async () => {
    const auth = await seedAuth("study-sitting");
    const quiz = await seedQuiz(auth, 2);
    const [right, wrong] = quiz.questionIds as [string, string];
    const before = Date.now();
    await completeQuizAttempt(auth, {
      quizId: quiz.quizId,
      idempotencyKey: crypto.randomUUID(),
      answers: [
        { questionId: right, selectedValue: "a", dontKnow: false },
        { questionId: wrong, selectedValue: "b", dontKnow: false },
      ],
    });
    const missed = await reviewOf(auth, { quizQuestionId: wrong });
    const recalled = await reviewOf(auth, { quizQuestionId: right });
    expect(missed!.lastRating).toBe("again");
    expect(missed!.dueAt.getTime() - before).toBeGreaterThan(9 * MIN);
    expect(missed!.dueAt.getTime() - before).toBeLessThan(11 * MIN);
    expect(recalled!.lastRating).toBe("good");
    expect(recalled!.intervalDays).toBe(1);

    const now = new Date();
    expect((await getStudyPlan(auth, { now })).items).toHaveLength(0);
    const later = await getStudyPlan(auth, { now: new Date(now.getTime() + 11 * MIN) });
    expect(later.items.map((i) => i.id)).toEqual([wrong]);
    const nextDay = await getStudyPlan(auth, { now: new Date(now.getTime() + 2 * DAY) });
    expect(nextDay.items.map((i) => i.id).sort()).toEqual([right, wrong].sort());
  });

  it("never sends a question's answer or explanation to the browser, and unseen questions are not due", async () => {
    const auth = await seedAuth("study-secret");
    const quiz = await seedQuiz(auth, 3);
    await completeQuizAttempt(auth, {
      quizId: quiz.quizId,
      idempotencyKey: crypto.randomUUID(),
      answers: quiz.questionIds.map((questionId) => ({ questionId, selectedValue: "b", dontKnow: false })),
    });
    const fresh = await seedQuiz(auth, 2); // never sat: scheduled by nothing
    const plan = await getStudyPlan(auth, { now: new Date(Date.now() + DAY) });
    expect(plan.items).toHaveLength(3);
    for (const item of plan.items) {
      expect(JSON.stringify(item)).not.toContain("Because alpha");
      expect(item).not.toHaveProperty("answerValue");
    }
    expect(plan.items.some((i) => fresh.questionIds.includes(i.id))).toBe(false);
  });

  it("answering in a session grades on the server, reveals the answer after, and reschedules", async () => {
    const auth = await seedAuth("study-answer");
    const other = await seedAuth("study-answer-other");
    const quiz = await seedQuiz(auth, 1);
    const [questionId] = quiz.questionIds as [string];

    await expect(answerStudyQuestion(auth, { questionId, selectedValue: "zzz" })).rejects.toBeInstanceOf(StudyError);
    await expect(answerStudyQuestion(other, { questionId, selectedValue: "a" })).rejects.toMatchObject({
      code: "question_not_found",
    });

    const wrong = await answerStudyQuestion(auth, { questionId, selectedValue: "b" });
    expect(wrong).toMatchObject({ correct: false, answerValue: "a", explanation: "Because alpha." });
    expect((await reviewOf(auth, { quizQuestionId: questionId }))!.lastRating).toBe("again");

    const dontKnow = await answerStudyQuestion(auth, { questionId, selectedValue: null });
    expect(dontKnow.correct).toBe(false);
    const right = await answerStudyQuestion(auth, { questionId, selectedValue: "a" });
    expect(right.correct).toBe(true);
    expect((await reviewOf(auth, { quizQuestionId: questionId }))!.lastRating).toBe("good");
    // The other workspace's schedule was never touched.
    expect(await reviewOf(other, { quizQuestionId: questionId })).toBeUndefined();
  });

  it("cards and questions share one session, interleaved by source, and due items move when answered", async () => {
    const auth = await seedAuth("study-mix");
    const docA = (await seedReadDocument(holder.db!, auth, "A.", "Doc A")).documentId;
    const docB = (await seedReadDocument(holder.db!, auth, "B.", "Doc B")).documentId;
    const a = await seedCards(auth, { documentId: docA, title: "Doc A", count: 4, prefix: "A" });
    const b = await seedCards(auth, { documentId: docB, title: "Doc B", count: 2, prefix: "B" });

    const plan = await getStudyPlan(auth);
    expect(plan.items).toHaveLength(6);
    expect(plan.dueNow).toBe(6);
    const sources = plan.items.map((i) => i.source);
    // Four from A and two from B: no two neighbours match until B runs out.
    expect(sources.slice(0, 4).every((s, i) => i === 0 || s !== sources[i - 1])).toBe(true);
    expect(plan.minutes).toBe(2);

    await rateFlashcard(auth, { flashcardId: a[0]!.id, rating: "good" });
    await rateFlashcard(auth, { flashcardId: b[0]!.id, rating: "again" });
    const after = await getStudyPlan(auth);
    expect(after.items.map((i) => i.id)).not.toContain(a[0]!.id);
    expect(after.dueNow).toBe(4);

    // The good card comes back tomorrow; the lapsed one is due again in ten minutes.
    const outlook = await getStudyOutlook(auth);
    expect(outlook.dueNow).toBe(4);
    expect(outlook.tomorrow).toBe(1);
    expect((await getStudyOutlook(auth, new Date(Date.now() + 12 * MIN))).dueNow).toBe(5);
  });

  it("a mission with a near date moves its concept's items to the front", async () => {
    const auth = await seedAuth("study-mission");
    const doc = (await seedReadDocument(holder.db!, auth, "A.", "Doc")).documentId;
    const cards = await seedCards(auth, { documentId: doc, title: "Doc", count: 3, prefix: "C" });
    const target = cards[2]!;
    const [concept] = await holder
      .db!.insert(concepts)
      .values({
        workspaceId: auth.workspaceId,
        term: "Scene graphs",
        sense: "domain",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: concepts.id });
    await holder
      .db!.insert(conceptLinks)
      .values({ workspaceId: auth.workspaceId, conceptId: concept!.id, flashcardId: target.id });
    const dueOn = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const [mission] = await holder
      .db!.insert(missions)
      .values({
        workspaceId: auth.workspaceId,
        goal: "Start at Intangible",
        role: "AI Engineer",
        dueOn,
        status: "active",
        requestKey: crypto.randomUUID(),
      })
      .returning({ id: missions.id });
    await holder.db!.insert(missionConcepts).values({
      workspaceId: auth.workspaceId,
      missionId: mission!.id,
      conceptId: concept!.id,
      ordinal: 0,
      reason: "Core to the role",
    });

    const plan = await getStudyPlan(auth, { minutes: 0.3 });
    expect(plan.items.map((i) => i.id)).toEqual([target.id]);
    expect(plan.mission).toEqual({ title: "AI Engineer", daysLeft: 3 });

    // A past date, or a draft, does not boost anything.
    await holder.db!.update(missions).set({ status: "archived" }).where(eq(missions.id, mission!.id));
    expect((await getStudyPlan(auth, { minutes: 0.3 })).mission).toBeNull();
  });

  it("another workspace's items never appear", async () => {
    const mine = await seedAuth("study-iso-a");
    const theirs = await seedAuth("study-iso-b");
    const doc = (await seedReadDocument(holder.db!, theirs, "T.", "Theirs")).documentId;
    await seedCards(theirs, { documentId: doc, title: "Theirs", count: 3, prefix: "T" });
    const plan = await getStudyPlan(mine);
    expect(plan.items).toHaveLength(0);
    expect(plan.dueNow).toBe(0);
  });
});
