import { describe, expect, it } from "vitest";
import { parseWriterFollowUp, reminderWindow } from "@/domains/agents/writer-draft";

/*
 * The follow-up pair's deterministic edges (ASH-288): the Writer's output
 * contract refuses routing keys, and the reminder window is the code's
 * calendar decision - the model's distance is a suggestion that gets clamped
 * and weekday-bounded, never trusted.
 */

describe("parseWriterFollowUp", () => {
  const good = {
    emailSubject: "Following up",
    emailBody: "Thanks for the session - as discussed, the next step is...",
    reminderSummary: "Check the proposal landed",
    suggestedDaysAhead: 2,
  };

  it("accepts the contract shape", () => {
    expect(parseWriterFollowUp(JSON.stringify(good))).toEqual(good);
  });

  it("refuses a model that tries to type a recipient", () => {
    expect(() => parseWriterFollowUp(JSON.stringify({ ...good, to: "someone@example.com" }))).toThrow(
      /recipient and routing/,
    );
  });

  it("refuses non-JSON and missing fields", () => {
    expect(() => parseWriterFollowUp("not json")).toThrow(/not JSON/);
    expect(() => parseWriterFollowUp(JSON.stringify({ emailSubject: "x" }))).toThrow(/unusable/);
  });
});

describe("reminderWindow", () => {
  // A Wednesday, 2:30 PM.
  const from = new Date("2026-10-21T14:30:00Z");

  it("lands the suggested weekday out, thirty minutes long", () => {
    const { startsAt, endsAt } = reminderWindow(from, 2);
    expect(startsAt.toISOString()).toBe("2026-10-23T14:30:00.000Z"); // Friday
    expect(endsAt.getTime() - startsAt.getTime()).toBe(30 * 60 * 1000);
  });

  it("bumps a weekend landing to Monday", () => {
    const { startsAt } = reminderWindow(from, 3); // Saturday
    expect(startsAt.getDay()).toBe(1);
  });

  it("clamps a suggestion outside the band", () => {
    const near = reminderWindow(from, 0);
    expect(near.startsAt.toISOString()).toBe("2026-10-22T14:30:00.000Z"); // 1 day
    const far = reminderWindow(from, 365);
    // Ten days out, plus the weekend bump - never further, never a weekend.
    expect(far.startsAt.getTime() - from.getTime()).toBeLessThanOrEqual(13 * 24 * 3600 * 1000);
    expect([1, 2, 3, 4, 5]).toContain(far.startsAt.getDay());
  });
});
