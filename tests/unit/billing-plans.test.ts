import { describe, expect, it } from "vitest";
import {
  FREE_WEEKLY_AI_CALLS,
  PRO_WEEKLY_AI_CALLS,
  currentWeek,
  settledPlan,
  weeklyAllowance,
} from "@/domains/billing/plans";

/*
 * Value: protects=the entitlement rules in one place; fails_when=the week
 * boundary slips off Monday UTC, own-key stops following keys, or Pro is
 * downgraded by adding a key; seam=the pure plan functions; no_claim=the
 * enforcement itself (billing.test.ts drives it through the resolver).
 */

describe("plans", () => {
  it("has one free constant and larger Pro allowance, none for own-key", () => {
    expect(weeklyAllowance("free")).toBe(FREE_WEEKLY_AI_CALLS);
    expect(weeklyAllowance("pro")).toBe(PRO_WEEKLY_AI_CALLS);
    expect(PRO_WEEKLY_AI_CALLS).toBeGreaterThan(FREE_WEEKLY_AI_CALLS);
    expect(weeklyAllowance("own-key")).toBe(0);
  });

  it("counts the week from Monday 00:00 UTC", () => {
    // Thursday 2026-11-12 15:30 UTC.
    const week = currentWeek(new Date("2026-11-12T15:30:00Z"));
    expect(week.start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(week.resetsAt.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    // Sunday belongs to the week that began the Monday before; Monday 00:00 starts a new one.
    expect(currentWeek(new Date("2026-11-15T23:59:59Z")).start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(currentWeek(new Date("2026-11-16T00:00:00Z")).start.toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });

  it("derives own-key from keys and leaves Pro alone", () => {
    expect(settledPlan("free", true)).toBe("own-key");
    expect(settledPlan("own-key", false)).toBe("free");
    expect(settledPlan("own-key", true)).toBe("own-key");
    expect(settledPlan("free", false)).toBe("free");
    expect(settledPlan("pro", true)).toBe("pro");
    expect(settledPlan("pro", false)).toBe("pro");
  });
});
