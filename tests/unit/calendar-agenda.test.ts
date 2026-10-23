import { describe, expect, it } from "vitest";
import { sanitizedReason, toAgendaEvent, workspaceDayWindow } from "@/domains/integrations/calendar-agenda";

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

  it("passes boundary-spanning events through with their real start/end", () => {
    // Google already filters by overlap with the window; an event that began
    // yesterday or spans midnight keeps its true times so the panel can
    // render it as continuing.
    const overnight = toAgendaEvent({ id: "e7", status: "confirmed", summary: "Red-eye", start: { dateTime: "2026-10-22T23:00:00Z" }, end: { dateTime: "2026-10-23T01:00:00Z" } });
    expect(overnight).toMatchObject({ startsAt: "2026-10-22T23:00:00Z", endsAt: "2026-10-23T01:00:00Z", allDay: false });
    const multiDay = toAgendaEvent({ id: "e8", status: "confirmed", summary: "Offsite", start: { date: "2026-10-22" }, end: { date: "2026-10-25" } });
    expect(multiDay).toMatchObject({ startsAt: "2026-10-22", endsAt: "2026-10-25", allDay: true });
  });

  it("names an untitled event honestly and trims blank summaries", () => {
    expect(toAgendaEvent({ id: "e5", status: "confirmed", summary: "  ", start: { date: "2026-10-23" } })?.title).toBe("(untitled event)");
    expect(toAgendaEvent({ id: "e6", status: "confirmed", start: { date: "2026-10-23" } })?.title).toBe("(untitled event)");
  });
});

describe("sanitizedReason", () => {
  it("passes through known-safe shapes and rewrites anything else", () => {
    expect(sanitizedReason(new Error("COMPOSIO_API_KEY is not set."))).toBe("Calendar sync is not configured on this deployment yet.");
    expect(sanitizedReason(new Error("Google Calendar read failed (HTTP 500)."))).toBe("Google Calendar could not be read (HTTP 500).");
    expect(sanitizedReason(new Error("Google Calendar returned an unexpected response."))).toBe("Google Calendar returned an unexpected response.");
  });

  it("never leaks raw provider or network detail", () => {
    expect(sanitizedReason(new Error("Request to https://backend.composio.dev/x?connected_account_id=ca_secret&access_token=ya29.leaked failed: 401 invalid_token"))).toBe("Google Calendar could not be read.");
    expect(sanitizedReason(new TypeError("fetch failed"))).toBe("Google Calendar could not be read.");
    expect(sanitizedReason("a string, not an Error")).toBe("Google Calendar could not be read.");
  });
});
