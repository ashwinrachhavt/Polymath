import { describe, expect, it } from "vitest";
import { GRADER_EVAL_CASES, validateCases } from "@/domains/learning/grader-eval-cases";

/*
 * The eval's fixtures are data with a contract: at least fifty answers, each
 * with a valid expected verdict, and enough of each kind that a false pass on
 * a wrong answer is actually observable. This test guards the fixtures, not
 * the model.
 */

describe("grader eval cases", () => {
  it("has at least fifty well-formed cases", () => {
    expect(() => validateCases(GRADER_EVAL_CASES)).not.toThrow();
    expect(GRADER_EVAL_CASES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(GRADER_EVAL_CASES.map((item) => item.id)).size).toBe(GRADER_EVAL_CASES.length);
  });

  it("spans correct, partial, incorrect and uncertain", () => {
    const counts = { correct: 0, partial: 0, incorrect: 0, uncertain: 0 };
    for (const item of GRADER_EVAL_CASES) counts[item.expected] += 1;
    for (const [kind, count] of Object.entries(counts)) {
      // Each bucket is large enough that one lucky grade cannot carry it.
      expect(count, kind).toBeGreaterThanOrEqual(5);
    }
  });

  it("marks every case as agent-drafted, and names the ones the agent is least sure about", () => {
    expect(GRADER_EVAL_CASES.every((item) => item.draft === true)).toBe(true);
    const leastCertain = GRADER_EVAL_CASES.filter((item) => item.leastCertain);
    expect(leastCertain.length).toBeGreaterThanOrEqual(10);
  });

  it("every case has a non-empty question and answer", () => {
    for (const item of GRADER_EVAL_CASES) {
      expect(item.question.trim().length).toBeGreaterThan(10);
      expect(item.answer.trim().length).toBeGreaterThan(5);
    }
  });
});
