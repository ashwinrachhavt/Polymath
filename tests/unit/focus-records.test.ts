import { describe, expect, it } from "vitest";
import { focusRecords } from "@/components/workspace/rewards";

describe("focus records", () => {
  it("reads back the minutes a focus session was recorded with", () => {
    // The focus screen's key shape: neuralflow-focus:<taskId>:<startedAt>:<duration>:<completed>.
    const sessionId = "neuralflow-focus:task-architecture:1760000000000:25:0";
    const [record] = focusRecords([{ id: "r1", title: "Clarity stone", earnedAt: "2026-10-17T17:00:00Z", sessionId }]);
    expect(record).toMatchObject({ taskId: "task-architecture", minutes: 25 });
  });

  it("keeps malformed keys out of the totals", () => {
    expect(
      focusRecords([{ id: "r2", title: "Clarity stone", earnedAt: "2026-10-17T17:00:00Z", sessionId: "legacy" }]),
    ).toEqual([]);
  });
});
