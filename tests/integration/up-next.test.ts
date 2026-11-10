import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { userPreferences } from "@/domains/identity/schema";
import { documentExtractions, documents, files, notebookSources, notebooks, sources } from "@/domains/knowledge/schema";
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

/*
 * A ready quiz on a fresh document. With `notebookId` the quiz was made in
 * that Notebook and the Notebook holds the document as a source, the way
 * generateNotebookQuizAction leaves them.
 */
async function seedReadyQuiz(auth: ReturnType<typeof ownerAuth>, title: string, notebookId: string | null = null) {
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
      notebookId,
      documentId: doc.id,
      sourceExtractionId: extraction.id,
      sourceManifest: [{ documentId: doc.id, extractionId: extraction.id, title }],
      title,
      status: "ready",
      questionCount: 3,
    })
    .returning();
  let source = null;
  if (notebookId) {
    [source] = await db
      .insert(sources)
      .values({ workspaceId: auth.workspaceId, kind: "file", title, fileId: file.id })
      .returning();
    await db.insert(notebookSources).values({ workspaceId: auth.workspaceId, notebookId, sourceId: source.id });
  }
  return { doc, quiz, source };
}

async function attempt(auth: ReturnType<typeof ownerAuth>, quizId: string) {
  await db.insert(quizAttempts).values({
    workspaceId: auth.workspaceId,
    quizId,
    userId: auth.userId,
    answers: [],
    correctCount: 1,
    totalCount: 3,
    idempotencyKey: crypto.randomUUID(),
  });
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
    const { quiz } = await seedReadyQuiz(auth, "Lease quiz", notebook.id);

    const result = await upNext.getUpNext(auth);

    expect(result.dueCards).toBe(2);
    expect(result.firstDue).toEqual({ notebookId: notebook.id, deckId: deck.id });
    expect(result.quizWaiting).toEqual({
      quizId: quiz.id,
      title: "Lease quiz",
      href: `/projects/${notebook.id}/notebook?quiz=${quiz.id}`,
    });
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

  it("a waiting quiz opens inside the Notebook that holds it, or is not offered", async () => {
    const auth = await seed();
    const [notebook] = await db
      .insert(notebooks)
      .values({ workspaceId: auth.workspaceId, title: "Lease notebook" })
      .returning();
    const waiting = async () => (await upNext.getUpNext(auth)).quizWaiting;

    // A quiz made outside any Notebook has no Notebook page to open in.
    await seedReadyQuiz(auth, "Loose quiz");
    expect(await waiting()).toBeNull();

    // A Notebook quiz is offered there, newest first.
    const older = await seedReadyQuiz(auth, "Older quiz", notebook.id);
    const newest = await seedReadyQuiz(auth, "Newest quiz", notebook.id);
    expect(await waiting()).toEqual({
      quizId: newest.quiz.id,
      title: "Newest quiz",
      href: `/projects/${notebook.id}/notebook?quiz=${newest.quiz.id}`,
    });

    // Once sat, the next one waits.
    await attempt(auth, newest.quiz.id);
    expect((await waiting())?.quizId).toBe(older.quiz.id);

    // The Notebook page hides a quiz whose source it no longer holds, so
    // Continue must not point there.
    await db.delete(notebookSources).where(eq(notebookSources.sourceId, older.source!.id));
    expect(await waiting()).toBeNull();
  });

  it("a quiz superseded by a newer generation on its document is not offered", async () => {
    const auth = await seed();
    const [notebook] = await db
      .insert(notebooks)
      .values({ workspaceId: auth.workspaceId, title: "Lease notebook" })
      .returning();
    const first = await seedReadyQuiz(auth, "Lease quiz", notebook.id);
    const [regenerated] = await db
      .insert(quizzes)
      .values({ ...first.quiz, id: undefined, generationKey: null, createdAt: sql`now() + interval '1 second'` })
      .returning();
    await attempt(auth, regenerated.id);

    // The library shows the regenerated quiz as sat; the older one is history.
    expect((await upNext.getUpNext(auth)).quizWaiting).toBeNull();
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
