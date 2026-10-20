import { describe, expect, it } from "vitest";
import { answer } from "@/domains/calendar/assist";

const ev = (title: string, d: number, h: number, mins: number, taskId: string | null = null) => ({
  title,
  startsAt: new Date(Date.UTC(2030, 0, d, h)).toISOString(),
  endsAt: new Date(Date.UTC(2030, 0, d, h) + mins * 60_000).toISOString(),
  taskId,
});
const ctx = {
  now: new Date(Date.UTC(2030, 0, 7, 0)),
  utcOffsetMinutes: 0,
  events: [ev("Standup", 7, 9, 30), ev("Spec", 8, 10, 120, "t1"), ev("Review", 8, 14, 60), ev("1:1", 9, 11, 30)],
};

describe("calendar assist", () => {
  it("names the busiest day", () => {
    expect(answer("What's my busiest day this week?", ctx)).toContain("Tuesday, Jan 8 is your busiest day with 3h");
  });
  it("lists focus blocks", () => {
    const a = answer("Show my focus blocks", ctx);
    expect(a).toContain("1 focus block");
    expect(a).toContain("Spec (2h)");
  });
  it("counts non-task events", () => {
    expect(answer("How many meetings do I have?", ctx)).toContain("3 events");
  });
  it("finds slots of the asked length that avoid events", () => {
    const a = answer("Find 2-hour slots for deep work", ctx);
    expect(a).toContain("Free 2h slots");
    expect(a).toContain("Mon 9:40 AM");
  });
  it("says what it can do for other questions", () => {
    expect(answer("book me a flight", ctx)).toContain("I can answer");
  });
  it("handles an empty week", () => {
    expect(answer("busiest day", { ...ctx, events: [] })).toBe("Nothing is scheduled this week.");
  });
});
