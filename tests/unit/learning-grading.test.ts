import { describe, expect, it } from "vitest";
import { gradeAttempt } from "@/domains/learning/grading";

/*
 * The grading fold's contract: value-keyed (positions do not exist in the
 * input, so shuffle order cannot corrupt a score), dontKnow is a gap and
 * never a wrong guess, and a missing answer grades as a gap too. Pure - the
 * unit project's fetch guard proves there is no I/O behind this.
 */

const QUESTIONS = [
  { id: "q1", answerValue: "rises" },
  { id: "q2", answerValue: "march" },
  { id: "q3", answerValue: "escrow" },
];

const correct = (questionId: string, selectedValue: string) => ({ questionId, selectedValue, dontKnow: false });
const gap = (questionId: string) => ({ questionId, selectedValue: null, dontKnow: true });

describe("gradeAttempt", () => {
  it("grades correct answers correct, by value", () => {
    const out = gradeAttempt(QUESTIONS, [correct("q1", "rises"), correct("q2", "march"), correct("q3", "escrow")]);
    expect(out).toEqual({
      correctCount: 3,
      totalCount: 3,
      perQuestion: [
        { questionId: "q1", correct: true, dontKnow: false },
        { questionId: "q2", correct: true, dontKnow: false },
        { questionId: "q3", correct: true, dontKnow: false },
      ],
    });
  });

  it("is indifferent to the order the answers arrive in - grading is value-keyed, not positional", () => {
    const forward = gradeAttempt(QUESTIONS, [correct("q1", "rises"), correct("q2", "march"), gap("q3")]);
    const reversed = gradeAttempt(QUESTIONS, [gap("q3"), correct("q2", "march"), correct("q1", "rises")]);
    expect(reversed).toEqual(forward);
    expect(forward.correctCount).toBe(2);
  });

  it("never grades dontKnow correct, even when the would-be selection matches", () => {
    const out = gradeAttempt(QUESTIONS, [
      { questionId: "q1", selectedValue: "rises", dontKnow: true },
      correct("q2", "march"),
      correct("q3", "escrow"),
    ]);
    expect(out.perQuestion[0]).toEqual({ questionId: "q1", correct: false, dontKnow: true });
    expect(out.correctCount).toBe(2);
  });

  it("grades a missing answer as a gap, never a guess", () => {
    const out = gradeAttempt(QUESTIONS, [correct("q1", "rises")]);
    expect(out.correctCount).toBe(1);
    expect(out.totalCount).toBe(3);
    expect(out.perQuestion.slice(1)).toEqual([
      { questionId: "q2", correct: false, dontKnow: true },
      { questionId: "q3", correct: false, dontKnow: true },
    ]);
  });

  it("grades a wrong value incorrect", () => {
    const out = gradeAttempt(QUESTIONS, [correct("q1", "falls"), correct("q2", "march"), correct("q3", "escrow")]);
    expect(out.perQuestion[0]).toEqual({ questionId: "q1", correct: false, dontKnow: false });
    expect(out.correctCount).toBe(2);
  });

  it("scores an empty sitting as all gaps over the full question count", () => {
    const out = gradeAttempt(QUESTIONS, []);
    expect(out).toEqual({
      correctCount: 0,
      totalCount: 3,
      perQuestion: [
        { questionId: "q1", correct: false, dontKnow: true },
        { questionId: "q2", correct: false, dontKnow: true },
        { questionId: "q3", correct: false, dontKnow: true },
      ],
    });
  });
});
