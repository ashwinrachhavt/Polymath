import { describe, expect, it } from "vitest";
import { DEFAULT_EASE, MIN_EASE, nextSchedule, parseEase, type ScheduleState } from "@/domains/learning/sm2";

const at = new Date("2026-10-19T12:00:00Z");
const fresh: ScheduleState = { intervalDays: 0, easeFactor: "2.5", reviewCount: 0 };

describe("parseEase", () => {
  it("reads a numeric string, a number, and falls back for garbage", () => {
    expect(parseEase("2.5")).toBe(2.5);
    expect(parseEase(2.1)).toBe(2.1);
    expect(parseEase("")).toBe(DEFAULT_EASE);
    expect(parseEase(null)).toBe(DEFAULT_EASE);
    expect(parseEase("not a number")).toBe(DEFAULT_EASE);
    // Below the floor is clamped up by the caller's schedule, but a stored
    // value under MIN_EASE is treated as missing, not as a permanent card.
    expect(parseEase("0.2")).toBe(DEFAULT_EASE);
  });
});

describe("nextSchedule", () => {
  it("schedules the first successful review one day out", () => {
    const s = nextSchedule(fresh, "recalled", at);
    expect(s.intervalDays).toBe(1);
    expect(s.dueOn.toISOString().slice(0, 10)).toBe("2026-10-20");
    // q=3 is the first passing grade: SM-2 lowers the ease by 0.14.
    expect(s.easeFactor).toBe(2.36);
  });

  it("schedules the second successful review six days out", () => {
    const s = nextSchedule({ intervalDays: 1, easeFactor: 2.5, reviewCount: 1 }, "explained", at);
    expect(s.intervalDays).toBe(6);
    expect(s.dueOn.toISOString().slice(0, 10)).toBe("2026-10-25");
    // q=4 leaves the ease unchanged.
    expect(s.easeFactor).toBe(2.5);
  });

  it("grows the interval by the updated ease after that", () => {
    const s = nextSchedule({ intervalDays: 6, easeFactor: 2.5, reviewCount: 2 }, "applied", at);
    // q=5 raises the ease to 2.6 first, then the interval is round(6 * 2.6).
    expect(s.easeFactor).toBe(2.6);
    expect(s.intervalDays).toBe(16);
  });

  it("resets a forgotten card to one day and drops the ease", () => {
    const s = nextSchedule({ intervalDays: 30, easeFactor: 2.5, reviewCount: 5 }, "forgot", at);
    expect(s.intervalDays).toBe(1);
    expect(s.dueOn.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(s.easeFactor).toBeLessThan(2.5);
  });

  it("repeats a struggled card soon and still lowers the ease", () => {
    const s = nextSchedule({ intervalDays: 20, easeFactor: 2.5, reviewCount: 4 }, "struggled", at);
    expect(s.intervalDays).toBe(1);
    expect(s.easeFactor).toBeLessThan(2.5);
  });

  it("never pushes the ease below the floor", () => {
    let state: ScheduleState = { intervalDays: 1, easeFactor: MIN_EASE, reviewCount: 3 };
    for (let i = 0; i < 10; i++) {
      const s = nextSchedule(state, "forgot", at);
      expect(s.easeFactor).toBeGreaterThanOrEqual(MIN_EASE);
      state = { intervalDays: s.intervalDays, easeFactor: s.easeFactor, reviewCount: state.reviewCount + 1 };
    }
  });

  it("never returns a zero or negative interval", () => {
    for (const result of ["forgot", "struggled", "recalled", "explained", "applied"] as const) {
      expect(nextSchedule(fresh, result, at).intervalDays).toBeGreaterThanOrEqual(1);
    }
  });

  it("computes a UTC day boundary, not a time of day", () => {
    const late = new Date("2026-10-19T23:59:59Z");
    const s = nextSchedule(fresh, "recalled", late);
    expect(s.dueOn.getUTCHours()).toBe(late.getUTCHours());
  });
});
