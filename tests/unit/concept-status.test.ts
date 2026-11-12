import { describe, expect, it } from "vitest";
import { CONCEPT_STATUSES, coverageTotal, deriveConceptStatus } from "@/domains/learning/concept-status";

/*
 * The status is derived from stored evidence only, so its rule is small and
 * total: every combination of (unaided correct, attempts) has one answer.
 * Coverage alone never moves it - an item existing is not evidence someone
 * can do the thing.
 */

describe("deriveConceptStatus", () => {
  it("proves a concept from any unaided correct answer, whatever else is there", () => {
    for (const attemptCount of [1, 2, 10, 100]) {
      expect(deriveConceptStatus({ unaidedCorrect: 1, attemptCount })).toBe("proven");
    }
  });

  it("withholds proof while every answer needed help", () => {
    for (const attemptCount of [1, 3, 50]) {
      expect(deriveConceptStatus({ unaidedCorrect: 0, attemptCount })).toBe("practised");
    }
  });

  it("calls nothing attempted unassessed", () => {
    expect(deriveConceptStatus({ unaidedCorrect: 0, attemptCount: 0 })).toBe("unassessed");
  });

  it("never reports a state outside the three it declares", () => {
    const seen = new Set(
      [0, 1, 2].flatMap((unaidedCorrect) =>
        [0, 1, 5].map((attemptCount) => deriveConceptStatus({ unaidedCorrect, attemptCount })),
      ),
    );
    for (const status of seen) expect(CONCEPT_STATUSES).toContain(status);
  });
});

describe("coverageTotal", () => {
  it("counts questions, cards and explanations together", () => {
    expect(coverageTotal({ questions: 2, cards: 3, explanations: 1 })).toBe(6);
    expect(coverageTotal({ questions: 0, cards: 0, explanations: 0 })).toBe(0);
  });
});
