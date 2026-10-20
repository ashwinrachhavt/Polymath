import { describe, expect, it } from "vitest";
import { approvalForCapability } from "../../eve/alfred/evals/axiom-policy";
import type { LearningItemView } from "@/domains/learning/queries";
import { toTeachingCard } from "@/domains/teaching/review-session";

/*
 * The teaching contract. Two properties matter and are cheap to pin:
 *
 *   1. a card handed to an agent never carries the answer, the answer index or
 *      the explanation, so the model cannot read the key while quizzing;
 *   2. the two capabilities are routed in the risk table, so they are grantable
 *      and appear in the approval decision rather than failing closed silently.
 */

function item(overrides: Partial<LearningItemView> = {}): LearningItemView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "quiz_question",
    prompt: "What restarts a card's interval?",
    answer: "An incorrect answer",
    options: ["A correct answer", "An incorrect answer", "A skipped review", "A new deck"],
    answerIndex: 1,
    explanation: "An incorrect answer resets the interval to one day.",
    status: "approved",
    dueOn: null,
    intervalDays: 0,
    reviewCount: 2,
    sourceQuote: "A card answered incorrectly restarts its interval at one day.",
    sourceDocumentId: "22222222-2222-4222-8222-222222222222",
    sourceTitle: "Spacing",
    ...overrides,
  };
}

describe("toTeachingCard", () => {
  it("never carries the answer, the index or the explanation", () => {
    const card = toTeachingCard(item());
    const keys = Object.keys(card);
    expect(keys).not.toContain("answer");
    expect(keys).not.toContain("answerIndex");
    expect(keys).not.toContain("explanation");
    // The correct option's text is present as one of four options, which is
    // the point of a multiple-choice card. What must not leak is WHICH one.
    expect(JSON.stringify(card)).not.toContain("answerIndex");
  });

  it("carries what a teacher needs: prompt, options, source passage", () => {
    const card = toTeachingCard(item());
    expect(card.prompt).toContain("restarts");
    expect(card.options).toHaveLength(4);
    expect(card.sourceQuote).toContain("restarts its interval");
    expect(card.sourceTitle).toBe("Spacing");
    expect(card.itemId).toBe(item().id);
  });

  it("tolerates a flashcard with no options", () => {
    const card = toTeachingCard(item({ kind: "flashcard", options: null, answerIndex: null, explanation: null }));
    expect(card.options).toBeNull();
  });
});

describe("teaching capabilities are routed", () => {
  it("notebook.open is a read and needs no approval", () => {
    expect(approvalForCapability("notebook.open")).toBe("approved");
  });

  it("learning.review is a local write and needs no approval", () => {
    expect(approvalForCapability("learning.review")).toBe("approved");
  });

  it("an unrouted capability still fails closed", () => {
    expect(approvalForCapability("learning.delete-everything")).toBe("denied");
  });
});
