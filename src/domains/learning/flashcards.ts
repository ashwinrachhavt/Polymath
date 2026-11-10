import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { locateQuoteNormalized } from "./locate-quote";
import { loadCurrentQuizSources, QuizGenerationError } from "./generate-quiz";
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

const MIN_FLASHCARDS = 3;
const MAX_FLASHCARDS = 15;

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

export async function generateFlashcardDeck(
  auth: AuthContext,
  input: { notebookId: string; documentIds: string[]; cardCount: number; idempotencyKey: string },
  generator?: FlashcardGenerator,
): Promise<{ deckId: string; cardCount: number }> {
  if (
    input.documentIds.length < 1 ||
    input.documentIds.length > 8 ||
    new Set(input.documentIds).size !== input.documentIds.length
  ) {
    throw new FlashcardError("invalid_sources", "Choose one to eight distinct sources.");
  }
  if (!Number.isInteger(input.cardCount) || input.cardCount < MIN_FLASHCARDS || input.cardCount > MAX_FLASHCARDS) {
    throw new FlashcardError("invalid_sources", "Choose between 3 and 15 flashcards.");
  }

  let sources;
  try {
    sources = await loadCurrentQuizSources(auth, input.documentIds);
  } catch (cause) {
    if (cause instanceof QuizGenerationError && cause.code === "no_extraction") {
      throw new FlashcardError(
        "source_not_ready",
        "Every selected source must finish reading before flashcards can be made.",
      );
    }
    throw new FlashcardError("invalid_sources", "One or more selected sources are unavailable in this workspace.");
  }
  const manifest: FlashcardSourceSnapshot[] = sources.map(({ documentId, extractionId, title }) => ({
    documentId,
    extractionId,
    title,
  }));
  const [prior] = await db
    .select({ id: flashcardDecks.id, sourceManifest: flashcardDecks.sourceManifest })
    .from(flashcardDecks)
    .where(
      and(eq(flashcardDecks.workspaceId, auth.workspaceId), eq(flashcardDecks.generationKey, input.idempotencyKey)),
    )
    .limit(1);
  if (prior) {
    if (JSON.stringify(prior.sourceManifest) !== JSON.stringify(manifest)) {
      throw new FlashcardError("invalid_sources", "This request key belongs to a different source selection.");
    }
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(flashcards)
      .where(and(eq(flashcards.workspaceId, auth.workspaceId), eq(flashcards.deckId, prior.id)));
    return { deckId: prior.id, cardCount: count };
  }

  const engine = generator ?? defaultFlashcardGenerator(auth.workspaceId);
  const learningContext = await flashcardGenerationContext(auth, input.documentIds);
  let proposed;
  try {
    proposed = await engine.generateFromSources(
      sources.map(({ title, text }) => ({ title, text })),
      { cardCount: input.cardCount, learningContext },
    );
  } catch {
    throw new FlashcardError("generation_failed", "Flashcards could not be generated. Try again.");
  }
  const verified = proposed.cards.flatMap((card, index) => {
    const source = sources[card.sourceIndex];
    if (!source || !card.prompt.trim() || !card.answer.trim()) return [];
    const span = locateQuoteNormalized(source.text, card.quote);
    if (!span) return [];
    return [
      {
        ordinal: index,
        prompt: card.prompt.trim().slice(0, 400),
        answer: card.answer.trim().slice(0, 1000),
        evidence: {
          quote: source.text.slice(span.start, span.end),
          startOffset: span.start,
          endOffset: span.end,
          source: { documentId: source.documentId, extractionId: source.extractionId, title: source.title },
        } satisfies FlashcardEvidence,
      },
    ];
  });
  const unique = verified.filter(
    (card, index) =>
      verified.findIndex((other) => other.prompt.toLocaleLowerCase() === card.prompt.toLocaleLowerCase()) === index,
  );
  if (unique.length < MIN_FLASHCARDS) {
    throw new FlashcardError(
      "insufficient_evidence",
      "Not enough distinct flashcards could be verified against the selected sources.",
    );
  }

  const title =
    sources.length === 1 ? sources[0].title + " flashcards" : sources[0].title + " + " + (sources.length - 1) + " more";
  return withTransaction(async (tx) => {
    const [deck] = await tx
      .insert(flashcardDecks)
      .values({
        workspaceId: auth.workspaceId,
        notebookId: input.notebookId,
        title: title.slice(0, 200),
        sourceManifest: manifest,
        generationKey: input.idempotencyKey,
        model: engine.name,
        promptVersion: FLASHCARD_PROMPT_VERSION,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: flashcardDecks.id });
    await tx.insert(flashcards).values(
      unique.slice(0, input.cardCount).map((card, ordinal) => ({
        workspaceId: auth.workspaceId,
        deckId: deck.id,
        ordinal,
        prompt: card.prompt,
        answer: card.answer,
        evidence: card.evidence,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })),
    );
    await recordAudit(
      auth,
      {
        action: "learning.flashcards_generated",
        subjectType: "flashcard_deck",
        subjectId: deck.id,
        summary: "Generated " + Math.min(unique.length, input.cardCount) + " source-grounded flashcards",
        metadata: {
          sourceCount: manifest.length,
          cardCount: Math.min(unique.length, input.cardCount),
          promptVersion: FLASHCARD_PROMPT_VERSION,
        },
      },
      tx,
    );
    return { deckId: deck.id, cardCount: Math.min(unique.length, input.cardCount) };
  });
}

export async function getFlashcardDeck(
  auth: AuthContext,
  deckId: string,
  onlyDue = false,
): Promise<{
  id: string;
  notebookId: string;
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
    notebookId: string;
    notebookTitle: string;
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
    .innerJoin(notebooks, and(eq(notebooks.id, flashcardDecks.notebookId), eq(notebooks.workspaceId, auth.workspaceId)))
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
