import { describe, expect, it } from "vitest";
import { nextCronRun } from "@/domains/knowledge/automation-ticker";

describe("nextCronRun", () => {
  it("finds the next minute match", () => {
    const after = new Date("2026-10-24T08:00:00Z");
    expect(nextCronRun("30 8 * * *", after)).toEqual(new Date("2026-10-24T08:30:00Z"));
  });

  it("rolls to the next day when today's time has passed", () => {
    const after = new Date("2026-10-24T09:00:00Z");
    expect(nextCronRun("30 8 * * *", after)).toEqual(new Date("2026-10-25T08:30:00Z"));
  });

  it("handles step values", () => {
    const after = new Date("2026-10-24T08:00:00Z");
    expect(nextCronRun("*/15 * * * *", after)).toEqual(new Date("2026-10-24T08:15:00Z"));
  });

  it("handles weekday restrictions", () => {
    // 2026-10-24 is a Saturday; next Monday is the 26th.
    const after = new Date("2026-10-24T08:00:00Z");
    expect(nextCronRun("0 9 * * 1", after)).toEqual(new Date("2026-10-26T09:00:00Z"));
  });

  it("rejects malformed expressions", () => {
    const after = new Date("2026-10-24T08:00:00Z");
    expect(nextCronRun("not cron", after)).toBeNull();
    expect(nextCronRun("61 * * * *", after)).toBeNull();
  });
});
