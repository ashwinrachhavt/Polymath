import { describe, expect, it } from "vitest";
import { focusRecords } from "@/components/workspace/rewards";
import { focusRewardKey } from "@/components/products/neuralflow/planning";

describe("focus records", () => {
  it("reads back the minutes a focus session was recorded with", () => {
    const sessionId = focusRewardKey({ taskId: "task-architecture", startedAt: 1760000000000, remaining: 0, duration: 25, status: "running", completed: 0 });
    const [record] = focusRecords([{ id: "r1", title: "Clarity stone", earnedAt: "2026-10-17T17:00:00Z", sessionId }]);
    expect(record).toMatchObject({ taskId: "task-architecture", minutes: 25 });
  });

  it("keeps malformed keys out of the totals", () => {
    expect(focusRecords([{ id: "r2", title: "Clarity stone", earnedAt: "2026-10-17T17:00:00Z", sessionId: "legacy" }])).toEqual([]);
  });
});
