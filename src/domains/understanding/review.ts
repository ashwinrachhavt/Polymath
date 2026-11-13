import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { linkItemsToConcepts } from "@/domains/learning/concept-links";
import {
  flashcardDecks,
  flashcards,
  type FlashcardEvidence,
  type FlashcardSourceSnapshot,
} from "@/domains/learning/schema";
import { withTransaction } from "@/lib/db-transaction";

/*
 * The one place a missed concept becomes something to practise. Today that is
 * a flashcard deck, due at once, so the cards show up in the daily practice
 * queue beside every other due card. When the study queue grows its own
 * scheduler this function is the only thing that changes its mind about where
 * review items go; callers hand it what was missed and never see the storage.
 *
 * Idempotent per attempt: the deck's request key names the attempt, so
 * recording the same sitting twice adds the cards once.
 */

type ReviewItem = {
  prompt: string;
  answer: string;
  evidence: Omit<FlashcardEvidence, "source">;
  concept: string;
};

export async function addReviewItems(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: { attemptId: string; title: string; source: FlashcardSourceSnapshot; items: ReviewItem[] },
): Promise<number> {
  if (input.items.length === 0) return 0;
  return withTransaction(async (tx) => {
    const [deck] = await tx
      .insert(flashcardDecks)
      .values({
        workspaceId: auth.workspaceId,
        title: input.title.slice(0, 200),
        sourceManifest: [input.source],
        generationKey: `understanding-review:${input.attemptId}`,
        model: "understanding-review",
        promptVersion: "missed@1",
        requestedCount: input.items.length,
        stoppedBy: "complete",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [flashcardDecks.workspaceId, flashcardDecks.generationKey] })
      .returning({ id: flashcardDecks.id });
    if (!deck) {
      const existing = await tx
        .select({ id: flashcards.id })
        .from(flashcards)
        .innerJoin(flashcardDecks, eq(flashcardDecks.id, flashcards.deckId))
        .where(
          and(
            eq(flashcardDecks.workspaceId, auth.workspaceId),
            eq(flashcardDecks.generationKey, `understanding-review:${input.attemptId}`),
          ),
        );
      return existing.length;
    }
    const stored = await tx
      .insert(flashcards)
      .values(
        input.items.map((item, ordinal) => ({
          workspaceId: auth.workspaceId,
          deckId: deck.id,
          ordinal,
          prompt: item.prompt,
          answer: item.answer,
          evidence: { ...item.evidence, source: input.source },
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })),
      )
      .returning({ id: flashcards.id, ordinal: flashcards.ordinal });
    await linkItemsToConcepts(
      auth,
      tx,
      stored.map((card) => ({ flashcardId: card.id, concept: input.items[card.ordinal].concept })),
    );
    return stored.length;
  });
}
