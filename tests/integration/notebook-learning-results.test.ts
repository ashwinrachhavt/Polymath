import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { memberships, users } from "@/domains/identity/schema";
import { documentExtractions, documents, files, notebooks } from "@/domains/knowledge/schema";
import {
  explainSessions,
  explainTurns,
  flashcardDecks,
  flashcards,
  quizQuestions,
  quizzes,
} from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Notebook's Results (consolidation Task 4.2): the latest quiz, deck and
 * Explain It session made in this notebook, each with everything it needs to
 * open in place. Another notebook's work, another learner's Explain It
 * session, a failed quiz and work pinned to a source the notebook no longer
 * holds never show. A ?quiz= deep link to one of this notebook's older
 * quizzes wins over the latest.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let results: typeof import("@/domains/learning/notebook-results");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  results = await import("@/domains/learning/notebook-results");
});

afterAll(async () => {
  await handle?.client.end();
});

const TEXT = "Fact zero holds. Fact one holds. Fact two holds.";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

async function seedDocument(workspaceId: string, title: string) {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: TEXT.length,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId, blobId: blob.id, filename: `${title}.txt` })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId, title, fileId: file.id, mimeType: "text/plain" })
    .returning();
  const [extraction] = await db
    .insert(documentExtractions)
    .values({ workspaceId, documentId: doc.id, contentHash: blob.contentHash, status: "succeeded", text: TEXT })
    .returning();
  return { documentId: doc.id, extractionId: extraction.id, title };
}

type Pin = Awaited<ReturnType<typeof seedDocument>>;

async function seedQuiz(
  workspaceId: string,
  input: { notebookId: string | null; pin: Pin; title: string; at: Date; status?: "ready" | "failed" },
) {
  const [quiz] = await db
    .insert(quizzes)
    .values({
      workspaceId,
      notebookId: input.notebookId,
      documentId: input.pin.documentId,
      sourceExtractionId: input.pin.extractionId,
      sourceManifest: [
        { documentId: input.pin.documentId, extractionId: input.pin.extractionId, title: input.pin.title },
      ],
      title: input.title,
      status: input.status ?? "ready",
      questionCount: 1,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning({ id: quizzes.id });
  await db.insert(quizQuestions).values({
    workspaceId,
    quizId: quiz.id,
    ordinal: 1,
    prompt: `${input.title}: what holds?`,
    choices: [
      { value: "zero", label: "Fact zero" },
      { value: "nine", label: "Fact nine" },
    ],
    answerValue: "zero",
    explanation: "Fact zero holds.",
    evidence: { quote: "Fact zero holds.", startOffset: 0, endOffset: 16 },
  });
  return quiz.id;
}

async function seedDeck(
  workspaceId: string,
  input: {
    notebookId: string;
    pin: Pin;
    title: string;
    at: Date;
    cards: number;
    requestedCount?: number | null;
    stoppedBy?: "complete" | "source_exhausted" | "batch_failed" | null;
  },
) {
  const [deck] = await db
    .insert(flashcardDecks)
    .values({
      workspaceId,
      notebookId: input.notebookId,
      title: input.title,
      sourceManifest: [
        { documentId: input.pin.documentId, extractionId: input.pin.extractionId, title: input.pin.title },
      ],
      generationKey: crypto.randomUUID(),
      model: "fixture",
      promptVersion: "test",
      requestedCount: input.requestedCount ?? null,
      stoppedBy: input.stoppedBy === undefined ? "complete" : input.stoppedBy,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning({ id: flashcardDecks.id });
  for (let ordinal = 0; ordinal < input.cards; ordinal++) {
    await db.insert(flashcards).values({
      workspaceId,
      deckId: deck.id,
      ordinal,
      prompt: `${input.title} card ${ordinal}`,
      answer: "Fact zero holds.",
      evidence: {
        quote: "Fact zero holds.",
        startOffset: 0,
        endOffset: 16,
        source: { documentId: input.pin.documentId, extractionId: input.pin.extractionId, title: input.pin.title },
      },
    });
  }
  return deck.id;
}

async function seedExplain(workspaceId: string, input: { notebookId: string; userId: string; pin: Pin; at: Date }) {
  const [session] = await db
    .insert(explainSessions)
    .values({
      workspaceId,
      notebookId: input.notebookId,
      userId: input.userId,
      sourceManifest: [
        { documentId: input.pin.documentId, extractionId: input.pin.extractionId, title: input.pin.title },
      ],
      generationKey: crypto.randomUUID(),
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning({ id: explainSessions.id });
  await db
    .insert(explainTurns)
    .values({ workspaceId, sessionId: session.id, ordinal: 0, prompt: "Explain why fact zero holds." });
  return session.id;
}

async function seedNotebook(workspaceId: string, title: string) {
  const [notebook] = await db.insert(notebooks).values({ workspaceId, title }).returning({ id: notebooks.id });
  return notebook.id;
}

suite("notebook learning results", () => {
  it("returns the latest quiz, deck and own Explain It session of this notebook, ready to open", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `results-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const [otherUser] = await db
      .insert(users)
      .values({ clerkUserId: `results_other_${Date.now()}` })
      .returning();
    await db.insert(memberships).values({ workspaceId, userId: otherUser.id, role: "member", status: "active" });
    const notebookId = await seedNotebook(workspaceId, "Mine");
    const otherNotebookId = await seedNotebook(workspaceId, "Other");
    const pin = await seedDocument(workspaceId, "Facts");
    const removedPin = await seedDocument(workspaceId, "Removed");

    const olderQuiz = await seedQuiz(workspaceId, { notebookId, pin, title: "Older quiz", at: minutesAgo(30) });
    const latestQuiz = await seedQuiz(workspaceId, { notebookId, pin, title: "Latest quiz", at: minutesAgo(20) });
    await seedQuiz(workspaceId, { notebookId, pin, title: "Failed quiz", at: minutesAgo(10), status: "failed" });
    await seedQuiz(workspaceId, { notebookId, pin: removedPin, title: "Removed-source quiz", at: minutesAgo(5) });
    const otherNotebookQuiz = await seedQuiz(workspaceId, {
      notebookId: otherNotebookId,
      pin,
      title: "Other notebook quiz",
      at: minutesAgo(1),
    });

    await seedDeck(workspaceId, { notebookId, pin, title: "Older deck", at: minutesAgo(30), cards: 3 });
    const latestDeck = await seedDeck(workspaceId, {
      notebookId,
      pin,
      title: "Latest deck",
      at: minutesAgo(20),
      cards: 8,
      requestedCount: 20,
      stoppedBy: "source_exhausted",
    });
    await seedDeck(workspaceId, { notebookId: otherNotebookId, pin, title: "Other deck", at: minutesAgo(1), cards: 4 });

    const mySession = await seedExplain(workspaceId, { notebookId, userId, pin, at: minutesAgo(20) });
    await seedExplain(workspaceId, { notebookId, userId: otherUser.id, pin, at: minutesAgo(1) });

    const found = await results.getNotebookLearningResults(auth, notebookId, { documentIds: [pin.documentId] });

    expect(found.quiz?.id).toBe(latestQuiz);
    expect(found.quiz?.title).toBe("Latest quiz");
    expect(found.quiz?.questions.map((q) => q.prompt)).toEqual(["Latest quiz: what holds?"]);

    expect(found.deck?.id).toBe(latestDeck);
    expect(found.deck?.title).toBe("Latest deck");
    expect(found.deck?.cards).toHaveLength(8);
    expect(found.deck?.requested).toBe(20);
    expect(found.deck?.stoppedBy).toBe("source_exhausted");

    expect(found.explain?.id).toBe(mySession);
    expect(found.explain?.turns.map((turn) => turn.prompt)).toEqual(["Explain why fact zero holds."]);

    // A ?quiz= deep link to an older quiz of this notebook opens that one;
    // another notebook's quiz is not this notebook's to open.
    const linked = await results.getNotebookLearningResults(auth, notebookId, {
      documentIds: [pin.documentId],
      quizId: olderQuiz,
    });
    expect(linked.quiz?.id).toBe(olderQuiz);
    const foreign = await results.getNotebookLearningResults(auth, notebookId, {
      documentIds: [pin.documentId],
      quizId: otherNotebookQuiz,
    });
    expect(foreign.quiz?.id).toBe(latestQuiz);

    // Once the notebook holds the removed source again, its quiz is the latest.
    const widened = await results.getNotebookLearningResults(auth, notebookId, {
      documentIds: [pin.documentId, removedPin.documentId],
    });
    expect(widened.quiz?.title).toBe("Removed-source quiz");
  });

  it("is empty for a notebook with nothing made, and never reads across workspaces", async () => {
    const mine = await seedWorkspace(db, `results-empty-${Date.now()}`);
    const theirs = await seedWorkspace(db, `results-theirs-${Date.now()}`);
    const notebookId = await seedNotebook(mine.workspaceId, "Empty");
    const pin = await seedDocument(mine.workspaceId, "Facts");
    await seedQuiz(mine.workspaceId, { notebookId, pin, title: "Mine", at: minutesAgo(1) });
    await seedDeck(mine.workspaceId, { notebookId, pin, title: "Mine", at: minutesAgo(1), cards: 3 });

    const empty = await results.getNotebookLearningResults(
      ownerAuth(mine.userId, mine.workspaceId),
      await seedNotebook(mine.workspaceId, "Nothing yet"),
      { documentIds: [pin.documentId] },
    );
    expect(empty).toEqual({ quiz: null, deck: null, explain: null });

    const crossWorkspace = await results.getNotebookLearningResults(
      ownerAuth(theirs.userId, theirs.workspaceId),
      notebookId,
      { documentIds: [pin.documentId] },
    );
    expect(crossWorkspace).toEqual({ quiz: null, deck: null, explain: null });
  });
});
