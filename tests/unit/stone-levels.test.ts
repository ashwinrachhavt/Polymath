import { describe, expect, it } from "vitest";
import { earnGuidance, TYPICAL_COINS, waysToEarn } from "@/domains/stones/guidance";
import { levelFor, LEVELS, MAX_LEVEL, unlockLevel, unlocksAt } from "@/domains/stones/levels";
import { COIN_RULES } from "@/domains/stones/awards";
import { loadCatalog } from "../../scripts/stones/catalog";

describe("levels", () => {
  it("starts at level 1 with nothing earned, and moves up exactly at each threshold", () => {
    expect(levelFor(0)).toMatchObject({ level: 1, name: "Pebble", toNext: 100, fraction: 0 });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100)).toMatchObject({ level: 2, name: "Prospector", toNext: 200 });
    expect(levelFor(8999).level).toBe(9);
    expect(levelFor(9000).level).toBe(MAX_LEVEL);
  });

  it("reports progress through the current level, and a full bar at the top", () => {
    expect(levelFor(200).fraction).toBeCloseTo(0.5);
    expect(levelFor(1_000_000)).toMatchObject({ level: MAX_LEVEL, next: null, toNext: 0, fraction: 1 });
  });

  it("never goes backward for a negative total", () => {
    expect(levelFor(-50).level).toBe(1);
  });

  it("has strictly rising thresholds and consecutive levels", () => {
    LEVELS.forEach((step, i) => {
      expect(step.level).toBe(i + 1);
      if (i > 0) expect(step.xp).toBeGreaterThan(LEVELS[i - 1].xp);
    });
  });
});

describe("stone unlocks", () => {
  it("opens crystals at 1, semi-precious at 3, precious at 6, gold at 9 and diamond at the top", () => {
    expect(unlockLevel({ slug: "pyrite", tier: "crystal" })).toBe(1);
    expect(unlockLevel({ slug: "citrine", tier: "semi_precious" })).toBe(3);
    expect(unlockLevel({ slug: "ruby", tier: "precious" })).toBe(6);
    expect(unlockLevel({ slug: "gold", tier: "legendary" })).toBe(9);
    expect(unlockLevel({ slug: "diamond", tier: "legendary" })).toBe(MAX_LEVEL);
  });

  it("names what each tier-opening level unlocks, and nothing for the others", () => {
    expect([3, 6, 9, 10].map(unlocksAt)).toEqual(["Semi-precious stones", "Precious stones", "Gold", "Diamond"]);
    expect(unlocksAt(2)).toBeNull();
  });

  it("gives every catalog stone an unlock level within 1 to the top, never below its tier's", () => {
    for (const stone of loadCatalog()) {
      const level = unlockLevel(stone);
      expect(level, stone.slug).toBeGreaterThanOrEqual(1);
      expect(level, stone.slug).toBeLessThanOrEqual(MAX_LEVEL);
    }
    const levels = loadCatalog().map((stone) => unlockLevel(stone));
    expect(levels.filter((level) => level === MAX_LEVEL)).toHaveLength(1);
  });
});

describe("earn guidance", () => {
  it("counts the quizzes, flashcards and tasks to reach the price", () => {
    const need = 120;
    const line = earnGuidance({ balance: 0, name: "Amethyst", price: need });
    expect(line).toBe(
      `About ${Math.ceil(need / TYPICAL_COINS.quiz)} quizzes or ${Math.ceil(need / TYPICAL_COINS.flashcard)} flashcards to afford Amethyst (120 coins).`,
    );
  });

  it("offers tasks only when the gap is small, and singular forms for one", () => {
    expect(earnGuidance({ balance: 115, name: "Pyrite", price: 120 })).toBe(
      "About 1 quiz, 3 flashcards or 1 task to afford Pyrite (120 coins).",
    );
  });

  it("says a stone can be bought when the balance covers it", () => {
    expect(earnGuidance({ balance: 120, name: "Amethyst", price: 120 })).toBe("You can buy Amethyst now (120 coins).");
  });

  it("derives its typical amounts from the award rules", () => {
    expect(TYPICAL_COINS.flashcard).toBe(COIN_RULES.flashcard.base);
    expect(TYPICAL_COINS.task).toBe(COIN_RULES.task.base);
    expect(TYPICAL_COINS.quiz).toBe(COIN_RULES.quiz.base + 30);
  });
});

describe("ways to earn today", () => {
  it("shows each activity's full ceiling on a fresh day", () => {
    expect(waysToEarn({}).map((row) => [row.kind, row.remaining])).toEqual([
      ["quiz", COIN_RULES.quiz.dailyCap],
      ["flashcard", COIN_RULES.flashcard.dailyCap],
      ["mission_mock", COIN_RULES.mission_mock.dailyCap],
      ["task", COIN_RULES.task.dailyCap],
    ]);
  });

  it("subtracts what was earned, and never goes below zero", () => {
    const rows = waysToEarn({ flashcard_reviewed: 20, task_completed: 999 });
    expect(rows.find((row) => row.kind === "flashcard")?.remaining).toBe(COIN_RULES.flashcard.dailyCap - 20);
    expect(rows.find((row) => row.kind === "task")?.remaining).toBe(0);
  });
});
