import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { conceptName, recentConceptNames } from "@/domains/knowledge/concepts";
import { linkItemsToConcepts } from "./concept-links";
import { locateQuoteNormalized } from "./locate-quote";
import { loadCurrentQuizSources, QuizGenerationError, sameSourceVersions } from "./generate-quiz";
import {
  flashcardDecks,
  flashcardReviews,
  flashcards,
  type FlashcardEvidence,
  type FlashcardSourceSnapshot,
} from "./schema";
import { notebooks } from "@/domains/knowledge/schema";
import {
  defaultFlashcardGenerator,
  FLASHCARD_PROMPT_VERSION,
  type FlashcardGenerator,
} from "@/integrations/learning/flashcard-generator";
import { flashcardGenerationContext } from "./generation-context";
import {
  defaultItemCount,
  generateInBatches,
  MAX_ITEM_COUNT,
  MAX_LEARNING_SOURCES,
  MIN_ITEM_COUNT,
  type GenerationOutcome,
} from "./item-count";

/** The fewest verified cards that make a deck worth keeping. */
const MIN_FLASHCARDS = 3;

type VerifiedCard = { prompt: string; answer: string; evidence: FlashcardEvidence; concept: string };

export class FlashcardError extends Error {
  constructor(
    public readonly code:
      "invalid_sources" | "source_not_ready" | "generation_failed" | "insufficient_evidence" | "card_not_found",
    message: string,
  ) {
    super(message);
    this.name = "FlashcardError";
  }
}

/**
 * Why a deck's generation ended, or `in_progress` while its batches are still
 * adding cards. A deck left unfinished longer than ABANDONED_AFTER_MS (the
 * run died part-way) reads as `batch_failed`: its stored cards stay usable.
 */
export type DeckGenerationState = GenerationOutcome | "in_progress";

/** Well past the longest batched run; an unfinished deck older than this was abandoned. */
const ABANDONED_AFTER_MS = 10 * 60 * 1000;

/**
 * Generate a source-grounded deck. `cardCount` is an exact request from
 * MIN_ITEM_COUNT to MAX_ITEM_COUNT; omitted, it scales with the sources
 * (defaultItemCount). Cards are made in batches and stored after each one,
 * so the first cards are usable while later batches run.
 *
 * The deck row, its first cards and the audit row are written in one
 * transaction once MIN_FLASHCARDS cards are verified; the deck's `stoppedBy`
 * stays null until the run ends, so a replay can tell a finished deck from
 * one still being made. Returns the cards stored, the count requested and
 * why the run stopped, so the surface can say "Made 8; the sources support
 * no more" apart from "Made 25; a later batch failed". Replaying an
 * idempotency key returns the stored deck in the same shape.
 */
export async function generateFlashcardDeck(
  auth: AuthContext,
  input: { notebookId?: string; documentIds: string[]; cardCount?: number; idempotencyKey: string },
  generator?: FlashcardGenerator,
): Promise<{ deckId: string; cardCount: number; requested: number; stoppedBy: DeckGenerationState }> {
  if (
    input.documentIds.length < 1 ||
    input.documentIds.length > MAX_LEARNING_SOURCES ||
    new Set(input.documentIds).size !== input.documentIds.length
  ) {
    throw new FlashcardError("invalid_sources", `Choose one to ${MAX_LEARNING_SOURCES} distinct sources.`);
  }
  if (
    input.cardCount !== undefined &&
    (!Number.isInteger(input.cardCount) || input.cardCount < MIN_ITEM_COUNT || input.cardCount > MAX_ITEM_COUNT)
  ) {
    throw new FlashcardError("invalid_sources", `Choose between ${MIN_ITEM_COUNT} and ${MAX_ITEM_COUNT} flashcards.`);
  }

  const sources = await loadCurrentQuizSources(auth, input.documentIds).catch((cause: unknown) => {
    if (cause instanceof QuizGenerationError && cause.code === "no_extraction") {
      throw new FlashcardError(
        "source_not_ready",
        "Every selected source must finish reading before flashcards can be made.",
      );
    }
    throw new FlashcardError("invalid_sources", "One or more selected sources are unavailable in this workspace.");
  });
  const manifest: FlashcardSourceSnapshot[] = sources.map(({ documentId, extractionId, title }) => ({
    documentId,
    extractionId,
    title,
  }));
  const [prior] = await db
    .select({
      id: flashcardDecks.id,
      notebookId: flashcardDecks.notebookId,
      sourceManifest: flashcardDecks.sourceManifest,
      requestedCount: flashcardDecks.requestedCount,
      stoppedBy: flashcardDecks.stoppedBy,
      updatedAt: flashcardDecks.updatedAt,
    })
    .from(flashcardDecks)
    .where(
      and(eq(flashcardDecks.workspaceId, auth.workspaceId), eq(flashcardDecks.generationKey, input.idempotencyKey)),
    )
    .limit(1);
  if (prior) {
    if (prior.notebookId !== (input.notebookId ?? null) || !sameSourceVersions(prior.sourceManifest, manifest)) {
      throw new FlashcardError("invalid_sources", "This request key belongs to a different source selection.");
    }
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(flashcards)
      .where(and(eq(flashcards.workspaceId, auth.workspaceId), eq(flashcards.deckId, prior.id)));
    const abandoned = Date.now() - prior.updatedAt.getTime() > ABANDONED_AFTER_MS;
    return {
      deckId: prior.id,
      cardCount: count,
      requested: prior.requestedCount ?? count,
      stoppedBy: prior.stoppedBy ?? (abandoned ? "batch_failed" : "in_progress"),
    };
  }

  const cardCount = input.cardCount ?? defaultItemCount(sources.reduce((sum, source) => sum + source.text.length, 0));
  const engine = generator ?? (await defaultFlashcardGenerator(auth.workspaceId));
  const learningContext = await flashcardGenerationContext(auth, input.documentIds);
  const knownConcepts = await recentConceptNames(auth);
  const title =
    sources.length === 1 ? sources[0].title + " flashcards" : sources[0].title + " + " + (sources.length - 1) + " more";

  async function proposeVerifiedCards(count: number, avoidPrompts: string[], part: number) {
    let proposed;
    try {
      proposed = await engine.generateFromSources(
        sources.map(({ title, text }) => ({ title, text })),
        { cardCount: count, learningContext, avoidPrompts, part, knownConcepts },
      );
    } catch {
      throw new FlashcardError("generation_failed", "Flashcards could not be generated. Try again.");
    }
    return proposed.cards.flatMap((card): VerifiedCard[] => {
      const source = sources[card.sourceIndex];
      if (!source || !card.prompt.trim() || !card.answer.trim()) return [];
      const span = locateQuoteNormalized(source.text, card.quote);
      const concept = conceptName(card.concept);
      if (!span || !concept) return [];
      return [
        {
          concept,
          prompt: card.prompt.trim().slice(0, 400),
          answer: card.answer.trim().slice(0, 1000),
          evidence: {
            quote: source.text.slice(span.start, span.end),
            startOffset: span.start,
            endOffset: span.end,
            source: { documentId: source.documentId, extractionId: source.extractionId, title: source.title },
          },
        },
      ];
    });
  }

  // Cards wait in memory until MIN_FLASHCARDS are verified, so a source that
  // cannot support a deck never leaves a near-empty deck behind.
  const deck: { id: string | null; stored: number } = { id: null, stored: 0 };
  async function storeNewCards(made: readonly VerifiedCard[]) {
    if (made.length < MIN_FLASHCARDS) return;
    await withTransaction(async (tx) => {
      let deckId = deck.id;
      if (deckId) {
        // Each batch bumps the deck, so a replay can tell a live run from an abandoned one.
        await tx
          .update(flashcardDecks)
          .set({ updatedAt: new Date(), updatedBy: auth.userId })
          .where(and(eq(flashcardDecks.id, deckId), eq(flashcardDecks.workspaceId, auth.workspaceId)));
      } else {
        deckId = await insertDeck(tx);
      }
      const fresh = made.slice(deck.stored);
      const stored = await tx
        .insert(flashcards)
        .values(
          fresh.map((card, index) => ({
            workspaceId: auth.workspaceId,
            deckId,
            ordinal: deck.stored + index,
            prompt: card.prompt,
            answer: card.answer,
            evidence: card.evidence,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })),
        )
        .returning({ id: flashcards.id, ordinal: flashcards.ordinal });
      await linkItemsToConcepts(
        auth,
        tx,
        stored.map((card) => ({ flashcardId: card.id, concept: fresh[card.ordinal - deck.stored].concept })),
      );
      deck.id = deckId;
    });
    deck.stored = made.length;
  }
  async function insertDeck(tx: TxDrizzle) {
    const [row] = await tx
      .insert(flashcardDecks)
      .values({
        workspaceId: auth.workspaceId,
        notebookId: input.notebookId,
        title: title.slice(0, 200),
        sourceManifest: manifest,
        generationKey: input.idempotencyKey,
        model: engine.name,
        promptVersion: FLASHCARD_PROMPT_VERSION,
        requestedCount: cardCount,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: flashcardDecks.id });
    await recordAudit(
      auth,
      {
        action: "learning.flashcards_generated",
        subjectType: "flashcard_deck",
        subjectId: row.id,
        summary: "Started a deck of up to " + cardCount + " source-grounded flashcards",
        metadata: { sourceCount: manifest.length, requested: cardCount, promptVersion: FLASHCARD_PROMPT_VERSION },
      },
      tx,
    );
    return row.id;
  }

  const { items, stoppedBy } = await generateInBatches(cardCount, proposeVerifiedCards, storeNewCards);
  const deckId = deck.id;
  if (!deckId) {
    throw new FlashcardError(
      "insufficient_evidence",
      "Not enough distinct flashcards could be verified against the selected sources.",
    );
  }
  await db
    .update(flashcardDecks)
    .set({ stoppedBy, updatedAt: new Date(), updatedBy: auth.userId })
    .where(and(eq(flashcardDecks.id, deckId), eq(flashcardDecks.workspaceId, auth.workspaceId)));
  return { deckId, cardCount: items.length, requested: cardCount, stoppedBy };
}

export async function getFlashcardDeck(
  auth: AuthContext,
  deckId: string,
  onlyDue = false,
): Promise<{
  id: string;
  notebookId: string | null;
  title: string;
  sourceManifest: FlashcardSourceSnapshot[];
  cards: Array<{ id: string; prompt: string; answer: string; evidence: FlashcardEvidence; dueAt: Date }>;
} | null> {
  const [deck] = await db
    .select({
      id: flashcardDecks.id,
      notebookId: flashcardDecks.notebookId,
      title: flashcardDecks.title,
      sourceManifest: flashcardDecks.sourceManifest,
    })
    .from(flashcardDecks)
    .where(and(eq(flashcardDecks.id, deckId), eq(flashcardDecks.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!deck) return null;
  const rows = await db
    .select({
      id: flashcards.id,
      prompt: flashcards.prompt,
      answer: flashcards.answer,
      evidence: flashcards.evidence,
      dueAt: flashcardReviews.dueAt,
    })
    .from(flashcards)
    .leftJoin(
      flashcardReviews,
      and(
        eq(flashcardReviews.flashcardId, flashcards.id),
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.userId, auth.userId),
      ),
    )
    .where(and(eq(flashcards.workspaceId, auth.workspaceId), eq(flashcards.deckId, deck.id)))
    .orderBy(asc(flashcards.ordinal));
  const now = new Date();
  const cards = rows.map((row) => ({ ...row, dueAt: row.dueAt ?? now })).filter((row) => !onlyDue || row.dueAt <= now);
  return { ...deck, cards };
}

export async function getFlashcardDueQueue(
  auth: AuthContext,
  limit = 50,
): Promise<
  Array<{
    flashcardId: string;
    deckId: string;
    /** Null for a deck made outside a Notebook; it is reviewed at deckReviewHref. */
    notebookId: string | null;
    notebookTitle: string | null;
    deckTitle: string;
    prompt: string;
    dueAt: Date;
  }>
> {
  const now = new Date();
  const rows = await db
    .select({
      flashcardId: flashcards.id,
      deckId: flashcardDecks.id,
      notebookId: flashcardDecks.notebookId,
      notebookTitle: notebooks.title,
      deckTitle: flashcardDecks.title,
      prompt: flashcards.prompt,
      dueAt: flashcardReviews.dueAt,
    })
    .from(flashcards)
    .innerJoin(
      flashcardDecks,
      and(eq(flashcardDecks.id, flashcards.deckId), eq(flashcardDecks.workspaceId, auth.workspaceId)),
    )
    .leftJoin(notebooks, and(eq(notebooks.id, flashcardDecks.notebookId), eq(notebooks.workspaceId, auth.workspaceId)))
    .leftJoin(
      flashcardReviews,
      and(
        eq(flashcardReviews.flashcardId, flashcards.id),
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.userId, auth.userId),
      ),
    )
    .where(and(eq(flashcards.workspaceId, auth.workspaceId), isDue(now)))
    .orderBy(sql`coalesce(${flashcardReviews.dueAt}, now())`, asc(flashcards.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => ({ ...row, dueAt: row.dueAt ?? now }));
}

/** How many cards are due for this user across every deck: the whole count, not a page of the queue. */
export async function countDueFlashcards(auth: AuthContext): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(flashcards)
    .leftJoin(
      flashcardReviews,
      and(
        eq(flashcardReviews.flashcardId, flashcards.id),
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.userId, auth.userId),
      ),
    )
    .where(and(eq(flashcards.workspaceId, auth.workspaceId), isDue(new Date())));
  return row?.count ?? 0;
}

/** A card is due for its learner once its review time has come, or when they have never rated it. */
function isDue(now: Date) {
  return or(isNull(flashcardReviews.id), lte(flashcardReviews.dueAt, now));
}

export async function rateFlashcard(
  auth: AuthContext,
  input: { flashcardId: string; rating: "again" | "hard" | "good" | "easy" },
): Promise<{ dueAt: Date }> {
  const [card] = await db
    .select({ id: flashcards.id })
    .from(flashcards)
    .where(and(eq(flashcards.id, input.flashcardId), eq(flashcards.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!card) throw new FlashcardError("card_not_found", "That flashcard is not available.");
  const [previous] = await db
    .select({
      intervalDays: flashcardReviews.intervalDays,
      ease: flashcardReviews.easeHundredths,
      repetitions: flashcardReviews.repetitions,
    })
    .from(flashcardReviews)
    .where(
      and(
        eq(flashcardReviews.workspaceId, auth.workspaceId),
        eq(flashcardReviews.flashcardId, card.id),
        eq(flashcardReviews.userId, auth.userId),
      ),
    )
    .limit(1);
  const ease = previous?.ease ?? 250;
  let intervalDays = previous?.intervalDays ?? 0;
  let easeHundredths = ease;
  let repetitions = previous?.repetitions ?? 0;
  let delayMs: number;

  if (input.rating === "again") {
    intervalDays = 0;
    repetitions = 0;
    easeHundredths = Math.max(130, ease - 20);
    delayMs = 10 * 60 * 1000;
  } else if (input.rating === "hard") {
    intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    repetitions += 1;
    easeHundredths = Math.max(130, ease - 15);
    delayMs = intervalDays * 24 * 60 * 60 * 1000;
  } else if (input.rating === "easy") {
    intervalDays = repetitions === 0 ? 4 : Math.max(4, Math.round(intervalDays * (ease / 100) * 1.3));
    repetitions += 1;
    easeHundredths = Math.min(350, ease + 15);
    delayMs = intervalDays * 24 * 60 * 60 * 1000;
  } else {
    intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 3 : Math.max(1, Math.round(intervalDays * (ease / 100)));
    repetitions += 1;
    delayMs = intervalDays * 24 * 60 * 60 * 1000;
  }
  const dueAt = new Date(Date.now() + delayMs);
  await withTransaction(async (tx) => {
    await tx
      .insert(flashcardReviews)
      .values({
        workspaceId: auth.workspaceId,
        flashcardId: card.id,
        userId: auth.userId,
        dueAt,
        intervalDays,
        easeHundredths,
        repetitions,
        lastRating: input.rating,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: [flashcardReviews.workspaceId, flashcardReviews.flashcardId, flashcardReviews.userId],
        set: {
          dueAt,
          intervalDays,
          easeHundredths,
          repetitions,
          lastRating: input.rating,
          updatedBy: auth.userId,
          updatedAt: new Date(),
        },
      });
    await recordAudit(
      auth,
      {
        action: "learning.flashcard_reviewed",
        subjectType: "flashcard",
        subjectId: card.id,
        summary: "Rated a flashcard " + input.rating,
        metadata: { rating: input.rating, intervalDays },
      },
      tx,
    );
  });
  return { dueAt };
}
