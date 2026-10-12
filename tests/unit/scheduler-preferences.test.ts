import { describe, expect, it } from "vitest";
import { earliestSuggestionHour, hourLabel, schedulerProblems, weekdaySummary } from "@/components/workspace/scheduler";
import type { SchedulerPreferences } from "@/components/workspace/types";

const base: SchedulerPreferences = { workStartHour: 9, workEndHour: 18, weekdays: [1, 2, 3, 4, 5], suggestionsEnabled: true, eveningEnabled: false, eveningStartHour: 19, eveningTitle: "Vibe coding", topics: [] };

describe("scheduler preferences", () => {
  it("accepts the default working week", () => {
    expect(schedulerProblems(base)).toEqual([]);
  });

  it("refuses an end hour at or before the start hour", () => {
    expect(schedulerProblems({ ...base, workEndHour: 9 })).toContain("Work end hour must be later than the work start hour.");
  });

  it("refuses a start hour outside the documented 5 to 12 window", () => {
    expect(schedulerProblems({ ...base, workStartHour: 4 }).length).toBeGreaterThan(0);
    expect(schedulerProblems({ ...base, workStartHour: 13 }).length).toBeGreaterThan(0);
  });

  it("allows no working days only when suggestions are off", () => {
    expect(schedulerProblems({ ...base, weekdays: [] }).length).toBe(1);
    expect(schedulerProblems({ ...base, weekdays: [], suggestionsEnabled: false })).toEqual([]);
  });

  it("treats an enabled evening session as valid on its own range", () => {
    expect(schedulerProblems({ ...base, eveningEnabled: true, eveningStartHour: 16 })).toEqual([]);
  });

  it("reports the earliest suggestion hour as the work start", () => {
    expect(earliestSuggestionHour({ ...base, workStartHour: 7 })).toBe(7);
  });

  it("reads hour 0 and 12 as 12am and 12pm", () => {
    expect(hourLabel(0)).toBe("12am");
    expect(hourLabel(12)).toBe("12pm");
    expect(hourLabel(13)).toBe("1pm");
    expect(hourLabel(23)).toBe("11pm");
  });

  it("names selected weekdays instead of printing raw numbers", () => {
    expect(weekdaySummary([1, 2, 3, 4, 5])).toBe("Mon, Tue, Wed, Thu, Fri");
    expect(weekdaySummary([0, 6])).toBe("Sun, Sat");
    expect(weekdaySummary([])).toBe("No working days selected");
    expect(weekdaySummary([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
  });
});
