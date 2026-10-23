import { describe, expect, it } from "vitest";
import { toAgendaEvent, workspaceDayWindow } from "@/domains/integrations/calendar-agenda";

describe("workspaceDayWindow", () => {
  const now = new Date("2026-10-23T18:00:00Z");

  it("bounds the local day in UTC for a UTC workspace", () => {
    const w = workspaceDayWindow("UTC", now);
    expect(w).toEqual({ day: "2026-10-23", timeMin: "2026-10-23T00:00:00.000Z", timeMax: "2026-10-24T00:00:00.000Z" });
  });

  it("bounds the local day for America/Los_Angeles (PDT, UTC-7)", () => {
    const w = workspaceDayWindow("America/Los_Angeles", now);
    expect(w.day).toBe("2026-10-23");
    expect(w.timeMin).toBe("2026-10-23T07:00:00.000Z");
    expect(w.timeMax).toBe("2026-10-24T07:00:00.000Z");
  });

  it("handles the fall-back DST day: 25 hours, midnights at -7 then -8", () => {
    const w = workspaceDayWindow("America/Los_Angeles", new Date("2026-11-01T12:00:00Z"));
    expect(w.day).toBe("2026-11-01");
    expect(w.timeMin).toBe("2026-11-01T07:00:00.000Z");
    expect(w.timeMax).toBe("2026-11-02T08:00:00.000Z");
  });

  it("handles the spring-forward DST day: 23 hours, midnights at -8 then -7", () => {
    const w = workspaceDayWindow("America/Los_Angeles", new Date("2026-03-08T12:00:00Z"));
    expect(w.day).toBe("2026-03-08");
    expect(w.timeMin).toBe("2026-03-08T08:00:00.000Z");
    expect(w.timeMax).toBe("2026-03-09T07:00:00.000Z");
  });

  it("uses the workspace-local day, not the UTC day, late at night", () => {
    // 2026-10-23 05:30 UTC is still 2026-10-22 22:30 in Los Angeles.
    const w = workspaceDayWindow("America/Los_Angeles", new Date("2026-10-23T05:30:00Z"));
    expect(w.day).toBe("2026-10-22");
  });

  it("handles a positive-offset zone (Asia/Kolkata, UTC+5:30)", () => {
    const w = workspaceDayWindow("Asia/Kolkata", now);
    expect(w.timeMin).toBe("2026-10-22T18:30:00.000Z");
    expect(w.timeMax).toBe("2026-10-23T18:30:00.000Z");
  });
});

describe("toAgendaEvent", () => {
  it("maps a timed event", () => {
    const e = toAgendaEvent({ id: "e1", status: "confirmed", summary: "Standup", location: "Zoom", start: { dateTime: "2026-10-23T16:00:00Z" }, end: { dateTime: "2026-10-23T16:30:00Z" } });
    expect(e).toEqual({ id: "e1", title: "Standup", startsAt: "2026-10-23T16:00:00Z", endsAt: "2026-10-23T16:30:00Z", allDay: false, location: "Zoom" });
  });

  it("maps an all-day event from its date", () => {
    const e = toAgendaEvent({ id: "e2", status: "confirmed", summary: "Holiday", start: { date: "2026-10-23" }, end: { date: "2026-10-24" } });
    expect(e).toMatchObject({ allDay: true, startsAt: "2026-10-23", endsAt: "2026-10-24", location: null });
  });

  it("drops cancelled events and events with no start", () => {
    expect(toAgendaEvent({ id: "e3", status: "cancelled", start: { dateTime: "2026-10-23T16:00:00Z" } })).toBeNull();
    expect(toAgendaEvent({ id: "e4", status: "confirmed" })).toBeNull();
  });

  it("names an untitled event honestly and trims blank summaries", () => {
    expect(toAgendaEvent({ id: "e5", status: "confirmed", summary: "  ", start: { date: "2026-10-23" } })?.title).toBe("(untitled event)");
    expect(toAgendaEvent({ id: "e6", status: "confirmed", start: { date: "2026-10-23" } })?.title).toBe("(untitled event)");
  });
});
