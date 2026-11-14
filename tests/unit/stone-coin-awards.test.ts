import { describe, expect, it } from "vitest";
import { coinAwardFor, COIN_RULES } from "@/domains/stones/awards";

const DAY = "2026-11-12";

describe("coin award rules", () => {
  it("pays a quiz a base plus a share for its score, keyed once per quiz per day", () => {
    const award = (correct: number, total: number) =>
      coinAwardFor({ kind: "quiz", quizId: "q1", attemptId: "a1", correct, total }, DAY);
    expect(award(0, 5)?.amount).toBe(10);
    expect(award(2, 3)?.amount).toBe(37);
    expect(award(5, 5)?.amount).toBe(50);
    expect(award(5, 5)).toMatchObject({
      reason: "quiz_completed",
      idempotencyKey: "quiz:q1:2026-11-12",
      subjectId: "a1",
    });
  });

  it("pays nothing for a quiz shorter than three questions", () => {
    expect(coinAwardFor({ kind: "quiz", quizId: "q1", attemptId: "a1", correct: 2, total: 2 }, DAY)).toBeNull();
  });

  it("pays every flashcard rating the same, once per card per day", () => {
    expect(coinAwardFor({ kind: "flashcard", flashcardId: "c1" }, DAY)).toMatchObject({
      amount: 2,
      idempotencyKey: "flashcard:c1:2026-11-12",
    });
  });

  it("pays a task once, ever: its key carries no day", () => {
    const one = coinAwardFor({ kind: "task", taskId: "t1" }, DAY);
    const later = coinAwardFor({ kind: "task", taskId: "t1" }, "2026-12-01");
    expect(one?.amount).toBe(5);
    expect(one?.idempotencyKey).toBe(later?.idempotencyKey);
  });

  it("pays a mock interview by readiness, once per mission per day, and nothing when nothing was asked", () => {
    const mock = (proven: number, asked: number) =>
      coinAwardFor({ kind: "mission_mock", missionId: "m1", sessionId: "s1", proven, asked }, DAY);
    expect(mock(0, 4)?.amount).toBe(30);
    expect(mock(2, 4)?.amount).toBe(90);
    expect(mock(4, 4)?.amount).toBe(150);
    expect(mock(4, 4)?.idempotencyKey).toBe("mission_mock:m1:2026-11-12");
    expect(mock(0, 0)).toBeNull();
  });

  it("carries each kind's daily ceiling, and no single award exceeds it", () => {
    for (const rule of Object.values(COIN_RULES)) {
      expect(rule.base + rule.forScore).toBeLessThanOrEqual(rule.dailyCap);
    }
  });
});
