import { describe, expect, it } from "vitest";
import {
  DIAMOND_LEVEL,
  TOPAZ_STREAK_DAYS,
  focusPointsForSession,
  levelForPoints,
  pointsForLevel,
  streakFromDays,
} from "@/domains/gamification/rules";

/*
 * Spec §5's math, table-driven: the level curve, the tier multipliers, and
 * the streak reader are pure functions, so the tables below are the whole
 * contract - the award code and the durable page both call these, and a
 * change to either without this table failing is a lie.
 */

describe("levelForPoints / pointsForLevel", () => {
  it("prices each level at a growing 100-point step (triangular), L2 at 100", () => {
    // Cumulative threshold where each level begins.
    expect(pointsForLevel(1)).toBe(0);
    expect(pointsForLevel(2)).toBe(100);
    expect(pointsForLevel(3)).toBe(300);
    expect(pointsForLevel(4)).toBe(600);
    expect(pointsForLevel(5)).toBe(1000);
  });

  it("returns the highest level whose threshold the points meet", () => {
    const cases: Array<[number, number]> = [
      [0, 1],
      [1, 1],
      [99, 1],
      [100, 2],
      [299, 2],
      [300, 3],
      [599, 3],
      [600, 4],
      [999, 4],
      [1000, 5],
      [1001, 5],
      [10499, 14], // pointsForLevel(15) = 10_500
      [10500, 15],
    ];
    for (const [points, level] of cases) expect(levelForPoints(points), `${points} points`).toBe(level);
  });

  it("keeps the mastery threshold and curve consistent", () => {
    expect(levelForPoints(pointsForLevel(DIAMOND_LEVEL))).toBe(DIAMOND_LEVEL);
    expect(levelForPoints(pointsForLevel(DIAMOND_LEVEL) - 1)).toBe(DIAMOND_LEVEL - 1);
  });
});

describe("focusPointsForSession", () => {
  it("rounds banked seconds up to whole 10-minute units, then applies the tier", () => {
    const cases: Array<[seconds: number, strictness: "normal" | "timeout" | "deep", points: number]> = [
      [0, "normal", 0],
      [1, "normal", 1],
      [599, "normal", 1],
      [600, "normal", 1],
      [601, "normal", 2],
      [700, "normal", 2],
      [1200, "normal", 2],
      [1, "timeout", 2], // ceil(1/600) = 1 × 1.5
      [700, "timeout", 3], // 2 × 1.5
      [1200, "timeout", 3],
      [1, "deep", 2],
      [700, "deep", 4],
      [2700, "deep", 10], // ceil(4.5) = 5 × 2
    ];
    for (const [seconds, strictness, points] of cases) {
      expect(focusPointsForSession(seconds, strictness), `${seconds}s ${strictness}`).toBe(points);
    }
  });

  it("never pays for a session with no banked time", () => {
    for (const strictness of ["normal", "timeout", "deep"] as const) {
      expect(focusPointsForSession(0, strictness)).toBe(0);
      expect(focusPointsForSession(-5, strictness)).toBe(0);
    }
  });
});

describe("streakFromDays", () => {
  it("reads an empty ledger as no streak at all", () => {
    expect(streakFromDays([], "2026-11-02")).toEqual({ current: 0, longest: 0 });
  });

  it("counts a run ending today, and grants yesterday the one-day grace", () => {
    expect(streakFromDays(["2026-10-31", "2026-11-01", "2026-11-02"], "2026-11-02")).toEqual({
      current: 3,
      longest: 3,
    });
    // Grace: today has not earned yet, but the run is not reported broken -
    // it stays alive at its earned length rather than dropping to zero.
    expect(streakFromDays(["2026-10-31", "2026-11-01"], "2026-11-02")).toEqual({ current: 2, longest: 2 });
  });

  it("starts the current streak at the last earning day, not at zero", () => {
    expect(streakFromDays(["2026-10-28", "2026-10-29", "2026-11-02"], "2026-11-02")).toEqual({
      current: 1,
      longest: 2,
    });
  });

  it("keeps longest and current separate across a gap", () => {
    expect(
      streakFromDays(
        ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-11-02"],
        "2026-11-02",
      ),
    ).toEqual({ current: 1, longest: 5 });
  });

  it("collapses duplicate days and unordered input", () => {
    expect(streakFromDays(["2026-11-02", "2026-11-02", "2026-11-01", "2026-10-31"], "2026-11-02")).toEqual({
      current: 3,
      longest: 3,
    });
  });

  it("topaz waits for seven consecutive days, not seven earning days", () => {
    // Production reads the streak after the award insert, so today's earning
    // day is in the set: six prior days plus today is exactly seven.
    const prior = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
    expect(streakFromDays(prior, "2026-11-02").current).toBe(TOPAZ_STREAK_DAYS - 1); // grace keeps it alive
    expect(streakFromDays([...prior, "2026-11-02"], "2026-11-02").current).toBe(TOPAZ_STREAK_DAYS);
    expect(streakFromDays(prior.slice(1), "2026-11-02").current).toBe(TOPAZ_STREAK_DAYS - 2);
  });
});
