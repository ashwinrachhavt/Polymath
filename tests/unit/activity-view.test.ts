import { describe, expect, it } from "vitest";
import { foldedStepTargets, groupActivityByDay } from "@/app/(workspace)/activity/present-view";
import type { ActivityItem } from "@/domains/audit/present";
import type { ActivityEventRow } from "@/domains/audit/queries";

/*
 * The Activity page's pure view layer: day grouping in the viewer's timezone
 * (the group header names the same calendar day dateKeyInTimezone names) and
 * the fold map that routes a deep-linked step row to the outcome whose
 * disclosure it renders under. The database-backed pieces live in the
 * integration suites.
 */

const NOW = new Date("2026-11-03T12:00:00.000Z"); // a Tuesday

const item = (occurredAt: string, sentence = "You did a thing"): ActivityItem =>
  ({
    occurredAt: new Date(occurredAt),
    sentence,
  }) as ActivityItem;

describe("groupActivityByDay", () => {
  it("labels today, yesterday, and older days in the viewer's timezone", () => {
    const groups = groupActivityByDay(
      [item("2026-11-03T09:00:00.000Z"), item("2026-11-02T09:00:00.000Z"), item("2026-11-01T09:00:00.000Z")],
      "UTC",
      NOW,
    );
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Sunday, Nov 1"]);
    expect(groups.map((group) => group.key)).toEqual(["2026-11-03", "2026-11-02", "2026-11-01"]);
  });

  it("buckets by the viewer's local day, not UTC's", () => {
    // 02:00 UTC on Nov 3 is 18:00 Nov 2 in Los Angeles: the same instant a
    // UTC grouping calls Today, a viewer in LA calls Yesterday.
    const groups = groupActivityByDay([item("2026-11-03T02:00:00.000Z")], "America/Los_Angeles", NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("2026-11-02");
    expect(groups[0]!.label).toBe("Yesterday");
  });

  it("keeps input order within and across groups", () => {
    const groups = groupActivityByDay(
      [
        item("2026-11-03T11:00:00.000Z", "newest"),
        item("2026-11-03T10:00:00.000Z", "middle"),
        item("2026-11-02T10:00:00.000Z", "older"),
      ],
      "UTC",
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.items.map((entry) => entry.sentence)).toEqual(["newest", "middle"]);
    expect(groups[1]!.items.map((entry) => entry.sentence)).toEqual(["older"]);
  });

  it("produces no groups for an empty page", () => {
    expect(groupActivityByDay([], "UTC", NOW)).toEqual([]);
  });
});

const row = (over: Partial<ActivityEventRow> = {}): ActivityEventRow => ({
  id: crypto.randomUUID(),
  action: "capture.converted",
  actorId: "viewer-1",
  actorKind: "user",
  subjectType: "capture",
  subjectId: crypto.randomUUID(),
  operationId: null,
  summary: "stored",
  createdAt: new Date("2026-11-03T12:00:00.000Z"),
  ...over,
});

describe("foldedStepTargets", () => {
  it("routes each step row to its operation's outcome row", () => {
    const outcome = row({ action: "capture.converted", operationId: "op-1" });
    const step = row({ action: "capture.proposal_accepted", operationId: "op-1" });
    const targets = foldedStepTargets([outcome, step]);
    expect(targets.get(step.id)).toBe(outcome.id);
    expect(targets.has(outcome.id)).toBe(false);
  });

  it("ignores rows without an operation and groups without an outcome on the page", () => {
    const standalone = row({ operationId: null });
    const stepOnly = row({ action: "capture.proposal_accepted", operationId: "op-missing-outcome" });
    const targets = foldedStepTargets([standalone, stepOnly]);
    expect(targets.size).toBe(0);
  });
});
