import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { documentExtractions, documents, files, notebooks } from "@/domains/knowledge/schema";
import { flashcardDecks, flashcards } from "@/domains/learning/schema";
import type { FlashcardGenerator } from "@/integrations/learning/flashcard-generator";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Large decks are generated in batches of at most 25 cards. Each later batch
 * is told the prompts already made, repeats are dropped, cards persist after
 * every batch, and a source that runs dry ends the deck early without an
 * error. The result says why the run stopped, and the deck row says whether
 * the run has finished. No model here: the generator is a fixture.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let deckModule: typeof import("@/domains/learning/flashcards");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  deckModule = await import("@/domains/learning/flashcards");
});

afterAll(async () => {
  await handle?.client.end();
});

/** "Fact 0 holds. Fact 1 holds. ..." so every card can quote its own sentence verbatim. */
function factText(sentences: number) {
  return Array.from({ length: sentences }, (_, n) => `Fact ${n} holds.`).join(" ");
}

async function seedNotebookSource(text: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `cards-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const auth = ownerAuth(userId, workspaceId);
  const [notebook] = await db
    .insert(notebooks)
    .values({ workspaceId, title: "Batching fixture" })
    .returning({ id: notebooks.id });
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: text.length,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db.insert(files).values({ workspaceId, blobId: blob.id, filename: "facts.txt" }).returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId, title: "Facts", fileId: file.id, mimeType: "text/plain" })
    .returning();
  await db
    .insert(documentExtractions)
    .values({ workspaceId, documentId: doc.id, contentHash: blob.contentHash, status: "succeeded", text });
  return { auth, notebookId: notebook.id, documentId: doc.id };
}

type Call = { cardCount: number; avoidPrompts: string[]; part: number | undefined; storedBefore: number };

/**
 * Returns `perCall` cards per call (capped by `supply` in total). The last
 * card of each call repeats the call's first prompt with different case and
 * spacing, so it must be dropped as a duplicate.
 */
function fixtureGenerator(options: {
  perCall: number;
  supply?: number;
  failOnCall?: number;
  deckCount: () => Promise<number>;
  /** Runs at the start of each call, after the earlier batches are stored. */
  onCall?: (call: number) => Promise<void>;
}) {
  const calls: Call[] = [];
  let made = 0;
  const generator: FlashcardGenerator = {
    name: "fixture:cards",
    async generateFromSources(_sources, request) {
      calls.push({
        cardCount: request.cardCount,
        avoidPrompts: request.avoidPrompts ?? [],
        part: request.part,
        storedBefore: await options.deckCount(),
      });
      await options.onCall?.(calls.length);
      if (options.failOnCall === calls.length) throw new Error("the driver exploded");
      const count = Math.min(options.perCall, (options.supply ?? Infinity) - made);
      const cards = Array.from({ length: count }, (_, i) => {
        const n = made + i;
        return {
          prompt: `What does fact ${n} say?`,
          answer: `Fact ${n} holds.`,
          quote: `Fact ${n} holds.`,
          sourceIndex: 0,
        };
      });
      if (options.supply === undefined && cards.length > 1) {
        cards[cards.length - 1] = { ...cards[0], prompt: `  WHAT does fact ${made}   say?` };
      }
      made += count;
      return { cards };
    },
  };
  return { generator, calls };
}

async function storedCards(workspaceId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(flashcards)
    .where(eq(flashcards.workspaceId, workspaceId));
  return count;
}

suite("flashcard batching", () => {
  it("a request for 50 makes two calls, tells the second what exists, and stores 48 unique cards", async () => {
    const { auth, notebookId, documentId } = await seedNotebookSource(factText(60));
    const idempotencyKey = crypto.randomUUID();
    const request = { notebookId, documentIds: [documentId], cardCount: 50, idempotencyKey };
    let midRun: { replay: unknown; audits: number } | undefined;
    const { generator, calls } = fixtureGenerator({
      perCall: 25,
      deckCount: () => storedCards(auth.workspaceId),
      // A double submit that lands while batch 2 runs sees an unfinished deck, not a final count.
      async onCall(call) {
        if (call !== 2) return;
        const replay = await deckModule.generateFlashcardDeck(auth, request, generator);
        const audits = await db
          .select()
          .from(auditEvents)
          .where(
            and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "learning.flashcards_generated")),
          );
        midRun = { replay, audits: audits.length };
      },
    });

    const out = await deckModule.generateFlashcardDeck(auth, request, generator);

    expect(calls.map((call) => call.cardCount)).toEqual([25, 25]);
    expect(calls.map((call) => call.part)).toEqual([0, 1]);
    expect(calls[0].avoidPrompts).toEqual([]);
    expect(calls[1].avoidPrompts).toHaveLength(24);
    // The first batch is stored before the second call starts.
    expect(calls[1].storedBefore).toBe(24);
    expect(out).toEqual({ deckId: out.deckId, cardCount: 48, requested: 50, stoppedBy: "source_exhausted" });
    // The deck, its first cards and its audit row commit together, before batch 2 starts.
    expect(midRun).toEqual({
      replay: { deckId: out.deckId, cardCount: 24, requested: 50, stoppedBy: "in_progress" },
      audits: 1,
    });
    const rows = await db
      .select({ prompt: flashcards.prompt, ordinal: flashcards.ordinal })
      .from(flashcards)
      .where(and(eq(flashcards.workspaceId, auth.workspaceId), eq(flashcards.deckId, out.deckId)))
      .orderBy(flashcards.ordinal);
    expect(rows).toHaveLength(48);
    expect(new Set(rows.map((row) => row.prompt.toLowerCase())).size).toBe(48);
    expect(rows.map((row) => row.ordinal)).toEqual(Array.from({ length: 48 }, (_, i) => i));

    // A replay of the same request returns the stored deck and count without a model call.
    const replay = await deckModule.generateFlashcardDeck(auth, request, generator);
    expect(replay).toEqual(out);
    expect(calls).toHaveLength(2);
    const [deck] = await db.select().from(flashcardDecks).where(eq(flashcardDecks.id, out.deckId));
    expect(deck).toMatchObject({ requestedCount: 50, stoppedBy: "source_exhausted" });

    // A run that died part-way leaves an unfinished deck; once it is stale, a replay says a batch failed.
    await db
      .update(flashcardDecks)
      .set({ stoppedBy: null, updatedAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(flashcardDecks.id, out.deckId));
    expect(await deckModule.generateFlashcardDeck(auth, request, generator)).toMatchObject({
      cardCount: 48,
      stoppedBy: "batch_failed",
    });
  });

  it("a source that supports only 8 cards gives 8, with no error", async () => {
    // Long enough that the default count is at least 20.
    const { auth, notebookId, documentId } = await seedNotebookSource(factText(600));
    const { generator, calls } = fixtureGenerator({
      perCall: 25,
      supply: 8,
      deckCount: () => storedCards(auth.workspaceId),
    });

    const out = await deckModule.generateFlashcardDeck(
      auth,
      { notebookId, documentIds: [documentId], idempotencyKey: crypto.randomUUID() },
      generator,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].cardCount).toBeGreaterThanOrEqual(20);
    expect(out).toMatchObject({ cardCount: 8, requested: calls[0].cardCount, stoppedBy: "source_exhausted" });
    expect(await storedCards(auth.workspaceId)).toBe(8);
    const decks = await db.select().from(flashcardDecks).where(eq(flashcardDecks.workspaceId, auth.workspaceId));
    expect(decks).toHaveLength(1);
  });

  it("a later batch that fails keeps the cards the first batch made", async () => {
    const { auth, notebookId, documentId } = await seedNotebookSource(factText(60));
    const { generator, calls } = fixtureGenerator({
      perCall: 25,
      failOnCall: 2,
      deckCount: () => storedCards(auth.workspaceId),
    });

    const out = await deckModule.generateFlashcardDeck(
      auth,
      { notebookId, documentIds: [documentId], cardCount: 50, idempotencyKey: crypto.randomUUID() },
      generator,
    );

    expect(calls).toHaveLength(2);
    // A failed batch is not the source running out: the surface must not say "the source supports no more".
    expect(out).toMatchObject({ cardCount: 24, requested: 50, stoppedBy: "batch_failed" });
    expect(await storedCards(auth.workspaceId)).toBe(24);
    const [deck] = await db.select().from(flashcardDecks).where(eq(flashcardDecks.id, out.deckId));
    expect(deck.stoppedBy).toBe("batch_failed");
  });

  it("a failed first batch stores nothing and reports the failure", async () => {
    const { auth, notebookId, documentId } = await seedNotebookSource(factText(60));
    const { generator } = fixtureGenerator({
      perCall: 25,
      failOnCall: 1,
      deckCount: () => storedCards(auth.workspaceId),
    });

    await expect(
      deckModule.generateFlashcardDeck(
        auth,
        { notebookId, documentIds: [documentId], cardCount: 30, idempotencyKey: crypto.randomUUID() },
        generator,
      ),
    ).rejects.toMatchObject({ code: "generation_failed" });
    expect(await db.select().from(flashcardDecks).where(eq(flashcardDecks.workspaceId, auth.workspaceId))).toHaveLength(
      0,
    );
  });
});
