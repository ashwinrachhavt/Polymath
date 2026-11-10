import { describe, expect, it } from "vitest";
import { defaultFlashcardGenerator } from "@/integrations/learning/flashcard-generator";

/*
 * The e2e fixture provider answers the flashcard generator (consolidation
 * Task 4.2), so the Learn this journey runs in CI with no model key: it
 * quotes the source's own sentences, so the deck verifier keeps every card.
 *
 * Value: protects=the learn-loop e2e reaching a real deck under
 * GENERATION_PROVIDER=fixture; fails_when=the fixture stops recognising the
 * flashcard prompt, ignores the requested count, repeats a prompt it was told
 * to avoid, or quotes text that is not in the source; seam=the real flashcard
 * generator over the real fixture provider; no_claim=card quality.
 */

const TEXT =
  "The queue settles each proposal. Every settle writes a receipt. Agents cite passages by title. " +
  "Notebooks pin source versions. Reviews are scheduled per learner. Stones need two thirds correct.";

describe("fixture flashcards", () => {
  const generator = defaultFlashcardGenerator(undefined, { GENERATION_PROVIDER: "fixture", NODE_ENV: "test" });

  it("makes the requested number of cards, each quoting a sentence of its source", async () => {
    const { cards } = await generator.generateFromSources([{ title: "Notes", text: TEXT }], { cardCount: 5 });
    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(card.sourceIndex).toBe(0);
      expect(TEXT).toContain(card.quote);
    }
    expect(new Set(cards.map((card) => card.prompt)).size).toBe(5);
  });

  it("returns fewer cards when the source runs out, and skips prompts it was told to avoid", async () => {
    const first = await generator.generateFromSources([{ title: "Notes", text: TEXT }], { cardCount: 25 });
    expect(first.cards).toHaveLength(6);
    const again = await generator.generateFromSources([{ title: "Notes", text: TEXT }], {
      cardCount: 25,
      avoidPrompts: first.cards.slice(0, 4).map((card) => card.prompt),
    });
    expect(again.cards.map((card) => card.prompt)).toEqual(first.cards.slice(4).map((card) => card.prompt));
  });
});
