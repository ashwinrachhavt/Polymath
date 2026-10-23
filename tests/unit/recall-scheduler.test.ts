import { describe, expect, it } from "vitest";
import { DEFAULT_EASE, MIN_EASE, nextRecallDue, RETRY_MINUTES } from "@/domains/knowledge/recall-scheduler";

/*
 * The scheduler is the whole recall contract: intervals expand on success,
 * a miss returns within the sitting, and ease never drops below the floor.
 * If any of that breaks, this file is the one check that fails.
 */

const now = new Date("2026-10-23T09:00:00Z");
const fresh = { intervalDays: 0, easeFactor: DEFAULT_EASE, reviewCount: 0 };

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

describe("nextRecallDue", () => {
  it("schedules the first successful review one day out", () => {
    const next = nextRecallDue(fresh, "correct", now);
    expect(next.intervalDays).toBe(1);
    expect(daysBetween(now, next.dueAt)).toBe(1);
  });

  it("expands the interval across successful reviews", () => {
    const first = nextRecallDue(fresh, "correct", now);
    const second = nextRecallDue({ intervalDays: first.intervalDays, easeFactor: first.easeFactor, reviewCount: 1 }, "correct", now);
    expect(second.intervalDays).toBe(6);
    const third = nextRecallDue({ intervalDays: second.intervalDays, easeFactor: second.easeFactor, reviewCount: 2 }, "correct", now);
    expect(third.intervalDays).toBeGreaterThan(6);
  });

  it("returns a missed card within the sitting and restarts the ladder", () => {
    const next = nextRecallDue({ intervalDays: 12, easeFactor: DEFAULT_EASE, reviewCount: 4 }, "wrong", now);
    expect(next.dueAt.getTime() - now.getTime()).toBe(RETRY_MINUTES * 60_000);
    expect(next.intervalDays).toBe(1);
    // The ladder restarts: the next success grows from the bottom again.
    const after = nextRecallDue({ intervalDays: next.intervalDays, easeFactor: next.easeFactor, reviewCount: 5 }, "correct", now);
    expect(after.intervalDays).toBeLessThanOrEqual(6);
  });

  it("never lets ease drop below the SM-2 floor", () => {
    let state = { intervalDays: 1, easeFactor: DEFAULT_EASE, reviewCount: 0 };
    for (let i = 0; i < 20; i++) {
      const next = nextRecallDue(state, "wrong", now);
      state = { intervalDays: next.intervalDays, easeFactor: next.easeFactor, reviewCount: state.reviewCount + 1 };
    }
    expect(state.easeFactor).toBe(MIN_EASE);
  });

  it("penalizes a miss with a lower ease than a recall", () => {
    const missed = nextRecallDue(fresh, "wrong", now);
    const recalled = nextRecallDue(fresh, "correct", now);
    expect(missed.easeFactor).toBeLessThan(recalled.easeFactor);
  });

  it("grows by whole days with no zero-length interval", () => {
    // Ease at the floor and a long history still yields at least one day.
    const next = nextRecallDue({ intervalDays: 1, easeFactor: MIN_EASE, reviewCount: 9 }, "correct", now);
    expect(next.intervalDays).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(next.intervalDays)).toBe(true);
  });
});
