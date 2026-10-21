import { describe, expect, it } from "vitest";
import { groupByRecency } from "@/lib/history-groups";

/*
 * The pinned clock in setup.clock.ts is 2026-01-15T12:00:00Z. These cases pass
 * `now` explicitly so the local-day boundaries do not depend on the machine's
 * time zone, and every fixture is built from local calendar parts for the same
 * reason.
 */
const at = (day: number, hour = 9) => new Date(2026, 0, day, hour, 0, 0);
const now = at(15, 12);

function keysFor(runs: Array<{ createdAt: Date }>) {
  return groupByRecency(runs, now).map((group) => ({
    key: group.key,
    count: group.rows.length,
  }));
}

describe("groupByRecency", () => {
  it("puts today's run under Today", () => {
    expect(keysFor([{ createdAt: at(15, 8) }])).toEqual([{ key: "today", count: 1 }]);
  });

  it("puts a run from three days ago under This week", () => {
    expect(keysFor([{ createdAt: at(12) }])).toEqual([{ key: "this-week", count: 1 }]);
  });

  it("puts a run from thirty days ago under Older", () => {
    expect(keysFor([{ createdAt: at(15 - 30) }])).toEqual([{ key: "older", count: 1 }]);
  });

  /*
   * Boundary: the week window is the six days before today. Exactly seven
   * calendar days back is a week old, not "this week", so it lands in Older.
   */
  it("puts a run from exactly seven days ago under Older", () => {
    expect(keysFor([{ createdAt: at(8) }])).toEqual([{ key: "older", count: 1 }]);
  });

  it("treats six days ago as the last day of This week", () => {
    expect(keysFor([{ createdAt: at(9) }])).toEqual([{ key: "this-week", count: 1 }]);
  });

  it("groups by calendar day, not elapsed hours", () => {
    // 23:50 yesterday is only ~12 hours old but belongs to yesterday.
    expect(keysFor([{ createdAt: at(14, 23) }])).toEqual([{ key: "this-week", count: 1 }]);
  });

  it("omits empty groups and keeps the order Today, This week, Older", () => {
    const groups = groupByRecency(
      [
        { createdAt: at(15, 8), id: "a" },
        { createdAt: at(1), id: "b" },
      ],
      now,
    );
    expect(groups.map((group) => group.label)).toEqual(["Today", "Older"]);
    expect(groups.every((group) => group.rows.length > 0)).toBe(true);
  });

  it("keeps input order within a group and accepts ISO strings", () => {
    const groups = groupByRecency(
      [
        { createdAt: at(15, 10).toISOString(), id: "first" },
        { createdAt: at(15, 11).toISOString(), id: "second" },
      ],
      now,
    );
    expect(groups[0].rows.map((row) => row.id)).toEqual(["first", "second"]);
  });
});
