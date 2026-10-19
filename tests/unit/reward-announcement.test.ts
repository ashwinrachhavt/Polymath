import { describe, expect, it } from "vitest";
import { ANNOUNCEMENT_WINDOW_MS, pickRewardAnnouncement } from "@/domains/gamification/queries";

const NOW = new Date("2026-10-19T12:00:00Z");

function entry(over: Record<string, unknown>) {
  return {
    id: "e1",
    workspaceId: "w",
    rewardDefinitionId: "d1",
    userId: null,
    reason: "task_completed",
    subjectType: "task",
    subjectId: null,
    points: 10,
    idempotencyKey: "k",
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: NOW,
    definitionKey: "quartz",
    definitionLabel: "Daily Quartz",
    definitionKind: "collectible",
    definitionThreshold: 1,
    ...over,
  } as never;
}

describe("pickRewardAnnouncement", () => {
  it("announces the newest fresh earning", () => {
    const a = pickRewardAnnouncement([entry({ id: "a" }), entry({ id: "b", createdAt: new Date(NOW.getTime() - 3_600_000) })], NOW);
    expect(a?.id).toBe("a");
    expect(a?.milestone).toBe(false);
  });

  it("skips shard claims and adjustments", () => {
    expect(pickRewardAnnouncement([entry({ reason: "adjustment", points: 0 })], NOW)).toBeNull();
    expect(pickRewardAnnouncement([entry({ points: 0 })], NOW)).toBeNull();
  });

  it("announces nothing for stale entries", () => {
    const old = entry({ createdAt: new Date(NOW.getTime() - ANNOUNCEMENT_WINDOW_MS - 1) });
    expect(pickRewardAnnouncement([old], NOW)).toBeNull();
  });

  it("treats badges and threshold rules as milestones", () => {
    expect(pickRewardAnnouncement([entry({ definitionKind: "badge" })], NOW)?.milestone).toBe(true);
    expect(pickRewardAnnouncement([entry({ definitionThreshold: 5 })], NOW)?.milestone).toBe(true);
  });
});
