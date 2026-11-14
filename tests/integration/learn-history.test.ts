import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  flashcardDecks,
  flashcardReviews,
  flashcards,
  quizAttempts,
  quizQuestions,
  quizzes,
} from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { seedReadDocument } from "../helpers/learning-fixtures";

/* Learn's history on real Postgres: one row per stack and per quiz, scoped to the learner. */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof makeTestDb>["db"] | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { listFlashcardStacks, listQuizHistory } from "@/domains/learning/history";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

type Auth = ReturnType<typeof ownerAuth>;
const DAY = 24 * 60 * 60 * 1000;

async function seedAuth(slug: string): Promise<Auth> {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `${slug}-${Date.now()}-${Math.random()}`);
  return ownerAuth(userId, workspaceId);
}

async function seedDeck(auth: Auth, title: string, count: number) {
  const [deck] = await holder
    .db!.insert(flashcardDecks)
    .values({
      workspaceId: auth.workspaceId,
      title,
      sourceManifest: [
        { documentId: crypto.randomUUID(), extractionId: crypto.randomUUID(), title: "> ## Source one" },
      ],
      generationKey: crypto.randomUUID(),
      model: "fixture",
      promptVersion: "fixture",
    })
    .returning({ id: flashcardDecks.id });
  const cards = await holder
    .db!.insert(flashcards)
    .values(
      Array.from({ length: count }, (_, ordinal) => ({
        workspaceId: auth.workspaceId,
        deckId: deck!.id,
        ordinal,
        prompt: `Card ${ordinal}`,
        answer: "Answer",
        evidence: {
          quote: "q",
          startOffset: 0,
          endOffset: 1,
          source: { documentId: crypto.randomUUID(), extractionId: crypto.randomUUID(), title: "S" },
        },
      })),
    )
    .returning({ id: flashcards.id });
  return { deckId: deck!.id, cards };
}

suite("learn history", { timeout: 60_000 }, () => {
  it("one row per stack with due, seen and remembered counts, and the last studied time", async () => {
    const auth = await seedAuth("history-stacks");
    const stack = await seedDeck(auth, "Agents", 4);
    await seedDeck(auth, "Empty-of-reviews", 2);
    const studied = new Date(Date.now() - 3 * DAY);
    const review = (flashcardId: string, over: Partial<typeof flashcardReviews.$inferInsert>) => ({
      workspaceId: auth.workspaceId,
      flashcardId,
      userId: auth.userId,
      updatedAt: studied,
      ...over,
    });
    await holder
      .db!.insert(flashcardReviews)
      .values([
        review(stack.cards[0]!.id, { dueAt: new Date(Date.now() + 10 * DAY), intervalDays: 8, repetitions: 3 }),
        review(stack.cards[1]!.id, { dueAt: new Date(Date.now() + DAY), intervalDays: 1, repetitions: 1 }),
        review(stack.cards[2]!.id, { dueAt: new Date(Date.now() - DAY), intervalDays: 1, repetitions: 1 }),
      ]);

    const rows = await listFlashcardStacks(auth);
    expect(rows).toHaveLength(2);
    const agents = rows.find((r) => r.title === "Agents")!;
    expect(agents).toMatchObject({ cardCount: 4, dueCount: 2, seenCount: 3, rememberedCount: 1, notebookId: null });
    expect(agents.sources).toEqual(["Source one"]);
    expect(Math.abs(agents.lastStudiedAt!.getTime() - studied.getTime())).toBeLessThan(1000);
    // Newest activity first: the stack made just now (all due, never studied) precedes the one studied 3 days ago.
    expect(rows[0]).toMatchObject({
      title: "Empty-of-reviews",
      cardCount: 2,
      dueCount: 2,
      seenCount: 0,
      lastStudiedAt: null,
    });
    expect(rows[1]!.title).toBe("Agents");
  });

  it("one row per quiz with latest, best and attempt count, for this learner only", async () => {
    const auth = await seedAuth("history-quizzes");
    const other = await seedAuth("history-quizzes-other");
    const { documentId, extractionId } = await seedReadDocument(holder.db!, auth, "Text.", "Doc");
    const make = async (title: string, status: "ready" | "failed" = "ready") => {
      const [quiz] = await holder
        .db!.insert(quizzes)
        .values({
          workspaceId: auth.workspaceId,
          documentId,
          sourceExtractionId: extractionId,
          title,
          status,
          questionCount: 5,
        })
        .returning({ id: quizzes.id });
      await holder.db!.insert(quizQuestions).values({
        workspaceId: auth.workspaceId,
        quizId: quiz!.id,
        ordinal: 0,
        prompt: "p",
        choices: [{ value: "a", label: "A" }],
        answerValue: "a",
        explanation: "e",
        evidence: { quote: "q", startOffset: 0, endOffset: 1 },
      });
      return quiz!.id;
    };
    const attempt = (quizId: string, userId: string, correct: number, daysAgo: number) =>
      holder.db!.insert(quizAttempts).values({
        workspaceId: auth.workspaceId,
        quizId,
        userId,
        answers: [],
        correctCount: correct,
        totalCount: 5,
        idempotencyKey: crypto.randomUUID(),
        createdAt: new Date(Date.now() - daysAgo * DAY),
      });
    const sat = await make("Sat twice");
    const fresh = await make("Never taken");
    await make("Failed one", "failed");
    await attempt(sat, auth.userId, 4, 5);
    await attempt(sat, auth.userId, 2, 1);
    await attempt(sat, other.userId, 5, 0);

    const rows = await listQuizHistory(auth);
    expect(rows.map((r) => r.title)).toEqual(["Never taken", "Sat twice"]);
    expect(rows[1]).toMatchObject({ quizId: sat, attempts: 2, latestCorrect: 2, bestCorrect: 4, questionCount: 5 });
    expect(rows[0]).toMatchObject({
      quizId: fresh,
      attempts: 0,
      latestCorrect: null,
      bestCorrect: null,
      latestAttemptedAt: null,
    });
    expect(await listQuizHistory(other)).toHaveLength(0);
  });
});
