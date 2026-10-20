import { describe, expect, it } from "vitest";
import { mapGoogleEvent, planSync } from "@/domains/calendar/google-mapper";

const timed = (id: string, etag: string, summary = "Standup") => ({
  id,
  etag,
  summary,
  start: { dateTime: "2030-01-07T17:00:00Z", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2030-01-07T17:30:00Z" },
});

describe("mapGoogleEvent", () => {
  it("maps a timed event", () => {
    const m = mapGoogleEvent(timed("a", "e1"))!;
    expect(m).toMatchObject({ providerObjectId: "a", title: "Standup", allDay: false, timezone: "America/Los_Angeles", status: "confirmed" });
    expect(m.endsAt.getTime() - m.startsAt.getTime()).toBe(30 * 60_000);
  });
  it("maps all-day events with an exclusive end date", () => {
    const m = mapGoogleEvent({ id: "d", start: { date: "2030-01-07" }, end: { date: "2030-01-09" } })!;
    expect(m.allDay).toBe(true);
    expect(m.endsAt.toISOString()).toBe("2030-01-09T00:00:00.000Z");
  });
  it("takes the RRULE and skips events without a usable range", () => {
    expect(mapGoogleEvent({ ...timed("r", "e"), recurrence: ["EXDATE:x", "RRULE:FREQ=WEEKLY"] })!.recurrenceRule).toBe("RRULE:FREQ=WEEKLY");
    expect(mapGoogleEvent({ id: "x", start: { dateTime: "2030-01-07T17:00:00Z" } })).toBeNull();
    expect(mapGoogleEvent({ id: "y", start: { dateTime: "2030-01-07T18:00:00Z" }, end: { dateTime: "2030-01-07T17:00:00Z" } })).toBeNull();
  });
  it("falls back to a placeholder title", () => {
    expect(mapGoogleEvent({ ...timed("n", "e"), summary: "  " })!.title).toBe("(no title)");
  });
});

describe("planSync", () => {
  const existing = [
    { id: "L1", providerObjectId: "same", providerEtag: "e1", status: "confirmed" },
    { id: "L2", providerObjectId: "changed", providerEtag: "old", status: "confirmed" },
    { id: "L3", providerObjectId: "gone", providerEtag: "e", status: "confirmed" },
  ];
  it("creates, updates, cancels and leaves unchanged rows alone", () => {
    const plan = planSync(existing, [
      timed("same", "e1"),
      timed("changed", "new"),
      { id: "gone", status: "cancelled" },
      timed("fresh", "f1"),
      { id: "bad" },
    ]);
    expect(plan.unchanged).toBe(1);
    expect(plan.update.map((u) => u.id)).toEqual(["L2"]);
    expect(plan.cancel).toEqual([{ id: "L3" }]);
    expect(plan.create.map((c) => c.providerObjectId)).toEqual(["fresh"]);
    expect(plan.skipped).toBe(1);
  });
  it("is idempotent: replaying the same payload after applying changes nothing", () => {
    const after = [{ id: "L9", providerObjectId: "fresh", providerEtag: "f1", status: "confirmed" }];
    const plan = planSync(after, [timed("fresh", "f1")]);
    expect(plan).toMatchObject({ create: [], update: [], cancel: [], unchanged: 1 });
  });
  it("ignores a cancellation for an event we never had", () => {
    expect(planSync([], [{ id: "ghost", status: "cancelled" }]).cancel).toEqual([]);
  });
});
