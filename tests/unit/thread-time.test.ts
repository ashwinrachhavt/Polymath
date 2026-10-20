import { describe, expect, it } from "vitest";
import { formatThreadTime } from "@/domains/conversations/queries";

/*
 * Regression (2026-10-20): `max(created_at)` reaches the conversations screen
 * as an ISO string, and `.toISOString()` on a string threw TypeError for the
 * whole screen. The formatter must accept both shapes and refuse garbage
 * quietly instead of crashing the list.
 */
describe("formatThreadTime", () => {
  it("formats a Date", () => {
    expect(formatThreadTime(new Date("2026-10-20T03:55:12Z"))).toBe("2026-10-20 03:55Z");
  });

  it("formats the ISO string Postgres delivers", () => {
    expect(formatThreadTime("2026-10-20T03:55:12.000Z")).toBe("2026-10-20 03:55Z");
  });

  it("renders null and undefined as a dash", () => {
    expect(formatThreadTime(null)).toBe("—");
    expect(formatThreadTime(undefined)).toBe("—");
  });

  it("renders an unparseable value as a dash instead of throwing", () => {
    expect(formatThreadTime("not a date")).toBe("—");
  });
});
