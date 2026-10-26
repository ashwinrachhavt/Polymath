import { describe, expect, it } from "vitest";
import { detectConflicts, resolutionOptions, type ConflictEvent, type MoveOption } from "@/domains/calendar/conflicts";
import { findFreeSlot } from "@/domains/calendar/slots";
import { addDays, localDate, offsetMinutesAt, resolveZone, wallToUtc } from "@/domains/calendar/zoned";

const LA = "America/Los_Angeles";
// US changes in 2030: spring forward Sun Mar 10, fall back Sun Nov 3.
const SPRING = { year: 2030, month: 3, day: 10 };
const FALL = { year: 2030, month: 11, day: 3 };
const iso = (d: Date) => d.toISOString();
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

describe("the fixtures are the real change days", () => {
  it("both are Sundays", () => {
    expect(new Date(Date.UTC(2030, 2, 10)).getUTCDay()).toBe(0);
    expect(new Date(Date.UTC(2030, 10, 3)).getUTCDay()).toBe(0);
  });
});

describe("wallToUtc", () => {
  it("shifts the same wall time by an hour across spring forward", () => {
    expect(iso(wallToUtc(LA, { year: 2030, month: 3, day: 9 }, 9 * 60))).toBe("2030-03-09T17:00:00.000Z");
    expect(iso(wallToUtc(LA, { year: 2030, month: 3, day: 11 }, 9 * 60))).toBe("2030-03-11T16:00:00.000Z");
  });

  it("puts a time that does not exist after the gap", () => {
    // 02:30 never happens on Mar 10; it reads as 03:30 PDT.
    expect(iso(wallToUtc(LA, SPRING, 2 * 60 + 30))).toBe("2030-03-10T10:30:00.000Z");
  });

  it("takes the first of a time that happens twice", () => {
    // 01:30 on Nov 3 is PDT (08:30Z) and then PST (09:30Z); the first wins.
    expect(iso(wallToUtc(LA, FALL, 60 + 30))).toBe("2030-11-03T08:30:00.000Z");
  });

  it("is exact on either side of the fall-back change", () => {
    expect(iso(wallToUtc(LA, FALL, 9 * 60))).toBe("2030-11-03T17:00:00.000Z");
    expect(iso(wallToUtc(LA, { year: 2030, month: 11, day: 2 }, 9 * 60))).toBe("2030-11-02T16:00:00.000Z");
  });

  it("handles half-hour zones, zones east of UTC, and an unknown zone", () => {
    expect(iso(wallToUtc("Asia/Kolkata", { year: 2030, month: 1, day: 7 }, 9 * 60))).toBe("2030-01-07T03:30:00.000Z");
    expect(iso(wallToUtc("Europe/London", { year: 2030, month: 7, day: 1 }, 9 * 60))).toBe("2030-07-01T08:00:00.000Z");
    expect(resolveZone("Not/AZone")).toBe("UTC");
    expect(iso(wallToUtc("Not/AZone", { year: 2030, month: 1, day: 7 }, 9 * 60))).toBe("2030-01-07T09:00:00.000Z");
  });
});

describe("local dates", () => {
  it("reads the date in the zone, not in UTC", () => {
    // 03:00Z on Jan 8 is still the evening of Jan 7 in Los Angeles.
    expect(localDate(utc(2030, 1, 8, 3), LA)).toEqual({ year: 2030, month: 1, day: 7 });
  });
  it("rolls month and year", () => {
    expect(addDays({ year: 2030, month: 12, day: 31 }, 1)).toEqual({ year: 2031, month: 1, day: 1 });
  });
  it("reports the offset in force at each instant", () => {
    expect(offsetMinutesAt(LA, utc(2030, 1, 7, 12))).toBe(-480);
    expect(offsetMinutesAt(LA, utc(2030, 7, 7, 12))).toBe(-420);
  });
});

describe("findFreeSlot with a time zone", () => {
  const base = { minutes: 60, busy: [], timeZone: LA, bufferMinutes: 0 };

  it("starts the next morning at 09:00 local on both sides of spring forward", () => {
    // Saturday evening PST -> Sunday 09:00 PDT: 16:00Z, not the 17:00Z a fixed -8h offset gives.
    const slot = findFreeSlot({ ...base, from: utc(2030, 3, 10, 3) });
    expect(iso(slot!.start)).toBe("2030-03-10T16:00:00.000Z");
    const monday = findFreeSlot({ ...base, from: utc(2030, 3, 11, 2) });
    expect(iso(monday!.start)).toBe("2030-03-11T16:00:00.000Z");
  });

  it("starts at 09:00 PST, 17:00Z, on the fall-back day", () => {
    const slot = findFreeSlot({ ...base, from: utc(2030, 11, 3, 3) });
    expect(iso(slot!.start)).toBe("2030-11-03T17:00:00.000Z");
  });

  it("stays inside the local window when a busy block pushes the search past a change", () => {
    const busy = [{ start: utc(2030, 3, 9, 17), end: utc(2030, 3, 10, 2) }];
    const slot = findFreeSlot({ ...base, from: utc(2030, 3, 9, 17), busy });
    expect(iso(slot!.start)).toBe("2030-03-10T16:00:00.000Z");
  });

  it("finds a slot inside a window that straddles the gap", () => {
    // Window 02:30-05:00 local on Mar 10 is 10:30Z-12:00Z: 90 real minutes, not 150.
    const slot = findFreeSlot({
      ...base,
      from: utc(2030, 3, 10, 8),
      earliestMinute: 2 * 60 + 30,
      latestMinute: 5 * 60,
      minutes: 90,
    });
    expect([iso(slot!.start), iso(slot!.end)]).toEqual(["2030-03-10T10:30:00.000Z", "2030-03-10T12:00:00.000Z"]);
    expect(findFreeSlot({ ...base, from: utc(2030, 3, 10, 8), earliestMinute: 2 * 60 + 30, latestMinute: 5 * 60, minutes: 120, horizonDays: 1 })).toBeNull();
  });
});

describe("resolution options across a daylight-saving change", () => {
  let n = 0;
  const ev = (title: string, start: Date, end: Date, over: Partial<ConflictEvent> = {}): ConflictEvent => ({
    id: `z${(n += 1)}`,
    title,
    startsAt: start,
    endsAt: end,
    version: 1,
    taskId: null,
    external: false,
    tentative: false,
    attendeeCount: 0,
    ...over,
  });

  it("moves a late-Saturday clash to Sunday morning at the new offset", () => {
    // Sat Mar 9, 16:30-17:30 PST (00:30Z-01:30Z Sun) clashes with a Google event.
    const local = ev("Review", utc(2030, 3, 10, 0, 30), utc(2030, 3, 10, 1, 30));
    const google = ev("Offsite", utc(2030, 3, 10, 0, 0), utc(2030, 3, 10, 2, 0), { external: true });
    const [conflict] = detectConflicts([local, google]);
    const moves = resolutionOptions(conflict, {
      now: utc(2030, 3, 9, 20),
      busy: [local, google],
      timeZone: LA,
      bufferMinutes: 0,
    }).filter((o): o is MoveOption => o.kind === "move");
    const later = moves.find((m) => m.shiftMinutes > 0)!;
    expect(iso(later.startsAt)).toBe("2030-03-10T16:00:00.000Z");
    expect(later.tradeOffs[0]).toContain("Sun, Mar 10, 9:00 AM");
    expect(later.tradeOffs[0]).not.toContain("the same day");
  });
});
