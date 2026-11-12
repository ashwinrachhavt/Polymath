/*
 * What the stored evidence says a person can do with one concept.
 *
 * Three plain states, derived only from recorded answers - never from a
 * model's opinion of itself:
 *
 * - proven: at least one answer was written from memory and graded correct
 *   against its sources (an Explain It answer, and later a mock interview
 *   answer). A self-rated flashcard or a multiple-choice guess never proves
 *   anything on its own.
 * - practised: work was done on the concept (a quiz sitting, a card reviewed,
 *   an explanation attempted) but no unaided answer was correct.
 * - unassessed: nothing has been attempted. Items covering the concept may
 *   exist; coverage is not evidence.
 *
 * An older item with no concept link is counted separately as "not yet
 * linked" by the reader, and never reaches this function as a failure.
 */

export const CONCEPT_STATUSES = ["unassessed", "practised", "proven"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

/** What a status needs from stored evidence. Coverage counts never affect it. */
export type ConceptStatusEvidence = {
  /** Answers written from memory and graded correct against their sources. */
  unaidedCorrect: number;
  /** Any stored attempt at an item covering the concept. */
  attemptCount: number;
};

export function deriveConceptStatus(evidence: ConceptStatusEvidence): ConceptStatus {
  if (evidence.unaidedCorrect > 0) return "proven";
  if (evidence.attemptCount > 0) return "practised";
  return "unassessed";
}

/** The words the screen shows. One place, so a status is never worded two ways. */
export const CONCEPT_STATUS_COPY: Record<ConceptStatus, { label: string; detail: string }> = {
  unassessed: {
    label: "Unassessed",
    detail: "Nothing has been answered yet.",
  },
  practised: {
    label: "Practised with help",
    detail: "Answered while the material was in front of you.",
  },
  proven: {
    label: "Proven unaided",
    detail: "Answered from memory and graded correct.",
  },
};

/** The three counts a concept card shows for the items that cover it. */
export type ConceptCoverage = { questions: number; cards: number; explanations: number };

export function coverageTotal(coverage: ConceptCoverage): number {
  return coverage.questions + coverage.cards + coverage.explanations;
}
