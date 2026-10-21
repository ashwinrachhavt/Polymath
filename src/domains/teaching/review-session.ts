import type { AuthContext } from "@/domains/identity/resolve";
import { dueItems, type LearningItemView } from "@/domains/learning/queries";
import { recordAttempt } from "@/domains/learning/commands";
import type { LearningResult } from "@/domains/learning/sm2";

/*
 * What an agent needs to teach (NotebookLM parity, S6).
 *
 * Two verbs, both narrow:
 *   - `nextReview` reads the due queue. It never reveals the answer: a teaching
 *     session asks first, then checks. Returning the answer to a model that is
 *     supposed to be quizzing someone would defeat the exercise.
 *   - `gradeReview` records the learner's result through the same command the
 *     UI uses, so an agent-graded review and a self-graded one land in the same
 *     attempt history and follow the same schedule.
 *
 * The command layer owns all authorization and scheduling; this module only
 * shapes the agent-facing contract.
 */

export const LEARNING_REVIEW_CAPABILITY = "learning.review";

/** A card as the agent sees it: the prompt and options, never the answer. */
export type TeachingCard = {
  itemId: string;
  kind: string;
  prompt: string;
  options: string[] | null;
  /** The source passage the question rests on, so the agent can teach from it. */
  sourceQuote: string | null;
  sourceTitle: string | null;
  reviewCount: number;
};

export function toTeachingCard(item: LearningItemView): TeachingCard {
  return {
    itemId: item.id,
    kind: item.kind,
    prompt: item.prompt,
    options: item.options,
    sourceQuote: item.sourceQuote,
    sourceTitle: item.sourceTitle,
    reviewCount: item.reviewCount,
  };
}

export async function nextReview(
  auth: AuthContext,
  input: { deckId?: string; limit?: number } = {},
): Promise<{ cards: TeachingCard[]; total: number }> {
  const items = await dueItems(auth, { deckId: input.deckId, limit: input.limit ?? 10 });
  return { cards: items.map(toTeachingCard), total: items.length };
}

/**
 * Records the learner's result. `idempotencyKey` is supplied by the caller so a
 * retried tool call does not grade the same card twice.
 */
export async function gradeReview(
  auth: AuthContext,
  input: { itemId: string; result: LearningResult; idempotencyKey: string },
) {
  return recordAttempt(auth, {
    itemId: input.itemId,
    result: input.result,
    idempotencyKey: input.idempotencyKey,
  });
}
