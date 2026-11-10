import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { userPreferences } from "@/domains/identity/schema";
import { documentExtractions, documents, files, notebooks } from "@/domains/knowledge/schema";
import { flashcardDecks, flashcards, quizAttempts, quizzes } from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Home's Up next on real Postgres: what is due, where Continue goes, and the
 * streak. Reviews go through rateFlashcard, the public write; only their
 * timestamps are moved back, because a test cannot wait for tomorrow.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let upNext: typeof import("@/domains/learning/up-next");
let flashcardCommands: typeof import("@/domains/learning/flashcards");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  upNext = await import("@/domains/learning/up-next");
  flashcardCommands = await import("@/domains/learning/flashcards");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed() {
  const { userId, workspaceId } = await seedWorkspace(db, `up-next-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return ownerAuth(userId, workspaceId);
}

async function seedDeck(auth: ReturnType<typeof ownerAuth>, cardCount: number) {
  const [notebook] = await db
    .insert(notebooks)
    .values({ workspaceId: auth.workspaceId, title: "Lease notebook" })
    .returning();
  const [deck] = await db
    .insert(flashcardDecks)
    .values({
      workspaceId: auth.workspaceId,
      notebookId: notebook.id,
      title: "Lease terms",
      sourceManifest: [],
      generationKey: crypto.randomUUID(),
      model: "fixture:flashcards",
      promptVersion: "fixture",
    })
    .returning();
  const cards = await db
    .insert(flashcards)
    .values(
      Array.from({ length: cardCount }, (_, ordinal) => ({
        workspaceId: auth.workspaceId,
        deckId: deck.id,
        ordinal,
        prompt: `Prompt ${ordinal}`,
        answer: `Answer ${ordinal}`,
        evidence: {
          quote: "q",
          startOffset: 0,
          endOffset: 1,
          source: { documentId: crypto.randomUUID(), extractionId: crypto.randomUUID(), title: "Lease" },
        },
      })),
    )
    .returning();
  return { notebook, deck, cards };
}

async function seedReadyQuiz(auth: ReturnType<typeof ownerAuth>, title: string) {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "fixture.txt" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "text/plain" })
    .returning();
  const [extraction] = await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      contentHash: blob.contentHash,
      status: "succeeded",
      text: "The lease renews on March 1.",
    })
    .returning();
  const [quiz] = await db
    .insert(quizzes)
    .values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      sourceExtractionId: extraction.id,
      title,
      status: "ready",
      questionCount: 3,
    })
    .returning();
  return { doc, quiz };
}

/** Rate a card now, then move that review `daysAgo` whole days back. */
async function reviewDaysAgo(auth: ReturnType<typeof ownerAuth>, flashcardId: string, daysAgo: number) {
  await flashcardCommands.rateFlashcard(auth, { flashcardId, rating: "good" });
  await db
    .update(auditEvents)
    .set({ createdAt: sql`${auditEvents.createdAt} - make_interval(days => ${daysAgo})` })
    .where(
      and(
        eq(auditEvents.workspaceId, auth.workspaceId),
        eq(auditEvents.subjectId, flashcardId),
        eq(auditEvents.action, "learning.flashcard_reviewed"),
      ),
    );
}

suite("up next", () => {
  it("counts due cards and links the first deck", async () => {
    const auth = await seed();
    const { notebook, deck, cards } = await seedDeck(auth, 3);
    // Reviewed today, so due in a day: no longer due.
    await flashcardCommands.rateFlashcard(auth, { flashcardId: cards[0].id, rating: "good" });
    const { doc, quiz } = await seedReadyQuiz(auth, "Lease quiz");

    const result = await upNext.getUpNext(auth);

    expect(result.dueCards).toBe(2);
    expect(result.firstDue).toEqual({ notebookId: notebook.id, deckId: deck.id });
    expect(result.quizWaiting).toEqual({ quizId: quiz.id, title: "Lease quiz", href: `/learn/${doc.id}` });
    expect(result.streakDays).toBe(1);

    // Another workspace sees none of it.
    const stranger = await seed();
    expect(await upNext.getUpNext(stranger)).toEqual({
      dueCards: 0,
      firstDue: null,
      quizWaiting: null,
      streakDays: 0,
    });
  });

  it("streak counts consecutive days and breaks on a gap", async () => {
    // A zone with no daylight saving, so N x 24 hours back is exactly N local days back.
    const zone = "Asia/Kolkata";

    const steady = await seed();
    await db.insert(userPreferences).values({ workspaceId: steady.workspaceId, userId: steady.userId, timezone: zone });
    const steadyDeck = await seedDeck(steady, 3);
    await reviewDaysAgo(steady, steadyDeck.cards[0].id, 2);
    await reviewDaysAgo(steady, steadyDeck.cards[1].id, 1);
    await reviewDaysAgo(steady, steadyDeck.cards[2].id, 0);
    expect((await upNext.getUpNext(steady)).streakDays).toBe(3);
    // A quiz attempt counts as a day of learning too.
    const { quiz } = await seedReadyQuiz(steady, "Lease quiz");
    await db.insert(quizAttempts).values({
      workspaceId: steady.workspaceId,
      quizId: quiz.id,
      userId: steady.userId,
      answers: [],
      correctCount: 0,
      totalCount: 3,
      idempotencyKey: crypto.randomUUID(),
      createdAt: sql`now() - interval '3 days'`,
    });
    expect((await upNext.getUpNext(steady)).streakDays).toBe(4);

    const gapped = await seed();
    await db.insert(userPreferences).values({ workspaceId: gapped.workspaceId, userId: gapped.userId, timezone: zone });
    const gappedDeck = await seedDeck(gapped, 2);
    await reviewDaysAgo(gapped, gappedDeck.cards[0].id, 3);
    await reviewDaysAgo(gapped, gappedDeck.cards[1].id, 1);
    // Nothing today yet: the streak still stands on yesterday, and D-3 is cut off by the gap.
    expect((await upNext.getUpNext(gapped)).streakDays).toBe(1);

    // Two days without learning ends it.
    await db
      .update(auditEvents)
      .set({ createdAt: sql`${auditEvents.createdAt} - interval '1 day'` })
      .where(eq(auditEvents.workspaceId, gapped.workspaceId));
    expect((await upNext.getUpNext(gapped)).streakDays).toBe(0);
  });

  it("no learning yet gives zeros and nulls", async () => {
    const auth = await seed();
    expect(await upNext.getUpNext(auth)).toEqual({
      dueCards: 0,
      firstDue: null,
      quizWaiting: null,
      streakDays: 0,
    });
  });
});
