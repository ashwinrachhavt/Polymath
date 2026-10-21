import { describe, expect, it } from "vitest";
import {
  dateFromKey,
  dateKeyInTimezone,
  keyOfPinnedDate,
  monthWindowOf,
  shiftDateKey,
  todayKeyInTimezone,
  weekdayOfKey,
  weekStartKeyOf,
} from "@/lib/local-date";

/*
 * The Work screens build "today" and week/month windows. These tests pin the
 * local-timezone contract: a UTC "today" must never show tomorrow while the
 * user is still in their own evening (the confirmed bug this module fixes).
 */

describe("dateKeyInTimezone", () => {
  // 2026-10-21T02:00:00Z is still the evening of the 20th in Los Angeles.
  const instant = new Date("2026-10-21T02:00:00Z");

  it("names the user's local calendar day, not the UTC day", () => {
    expect(dateKeyInTimezone(instant, "America/Los_Angeles")).toBe("2026-10-20");
    expect(dateKeyInTimezone(instant, "UTC")).toBe("2026-10-21");
    expect(dateKeyInTimezone(instant, "Asia/Kolkata")).toBe("2026-10-21");
  });

  it("todayKeyInTimezone agrees with dateKeyInTimezone for the same instant", () => {
    expect(todayKeyInTimezone("America/Los_Angeles", instant)).toBe("2026-10-20");
  });

  it("handles DST transitions in both directions", () => {
    // 2026-03-08 is the spring-forward Sunday in America/Los_Angeles.
    expect(dateKeyInTimezone(new Date("2026-03-08T09:30:00Z"), "America/Los_Angeles")).toBe("2026-03-08");
    // 2026-11-01 is the fall-back Sunday.
    expect(dateKeyInTimezone(new Date("2026-11-01T08:30:00Z"), "America/Los_Angeles")).toBe("2026-11-01");
  });
});

describe("the noon-UTC pin", () => {
  it("round-trips through the local key for practical timezones", () => {
    for (const tz of ["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Sydney"]) {
      expect(dateKeyInTimezone(dateFromKey("2026-10-21"), tz)).toBe("2026-10-21");
    }
  });

  it("keyOfPinnedDate reads the stored day back", () => {
    expect(keyOfPinnedDate(dateFromKey("2026-02-28"))).toBe("2026-02-28");
  });
});

describe("shiftDateKey", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDateKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("leap years", () => {
    expect(shiftDateKey("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("monthWindowOf", () => {
  it("bounds the month of the key", () => {
    expect(monthWindowOf("2026-10-21")).toEqual({ startKey: "2026-10-01", nextStartKey: "2026-11-01" });
    expect(monthWindowOf("2026-12-15")).toEqual({ startKey: "2026-12-01", nextStartKey: "2027-01-01" });
  });
});

describe("weekStartKeyOf", () => {
  // 2026-10-21 is a Wednesday.
  it("starts Monday when weekStart is 1", () => {
    expect(weekStartKeyOf("2026-10-21", 1)).toBe("2026-10-19");
  });

  it("starts Sunday when weekStart is 7", () => {
    expect(weekStartKeyOf("2026-10-21", 7)).toBe("2026-10-18");
  });

  it("returns the key itself when it is already the week start", () => {
    expect(weekStartKeyOf("2026-10-19", 1)).toBe("2026-10-19");
  });

  it("weekdayOfKey matches the real weekday", () => {
    expect(weekdayOfKey("2026-10-21")).toBe(3); // Wednesday
    expect(weekdayOfKey("2026-10-18")).toBe(0); // Sunday
  });
});
