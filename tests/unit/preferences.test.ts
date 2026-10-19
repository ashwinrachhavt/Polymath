import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, validatePreferencePatch } from "@/domains/identity/preferences";

/*
 * D23 validation rules: the same checks run on the server for every save,
 * so a hand-rolled caller gets the same answer as the settings form.
 */

describe("validatePreferencePatch", () => {
  it("accepts a full valid patch", () => {
    const patch = validatePreferencePatch({ timezone: "America/Los_Angeles", weekStart: 7, appearance: "dark", motion: "reduced" });
    expect(patch).toEqual({ timezone: "America/Los_Angeles", weekStart: 7, appearance: "dark", motion: "reduced" });
  });

  it("accepts an empty patch", () => {
    expect(validatePreferencePatch({})).toEqual({});
  });

  it("rejects an unknown timezone", () => {
    expect(() => validatePreferencePatch({ timezone: "Mars/Olympus_Mons" })).toThrow(/not a recognized IANA timezone/);
  });

  it("rejects an over-long timezone string before touching Intl", () => {
    expect(() => validatePreferencePatch({ timezone: `UTC${"x".repeat(100)}` })).toThrow(/IANA identifier/);
  });

  it("rejects non-ISO week starts", () => {
    expect(() => validatePreferencePatch({ weekStart: 0 })).toThrow(/ISO weekday/);
    expect(() => validatePreferencePatch({ weekStart: 8 })).toThrow(/ISO weekday/);
    expect(() => validatePreferencePatch({ weekStart: 1.5 })).toThrow(/ISO weekday/);
  });

  it("rejects unknown appearance and motion values", () => {
    expect(() => validatePreferencePatch({ appearance: "purple" as never })).toThrow(/light, dark or system/);
    expect(() => validatePreferencePatch({ motion: "spinning" as never })).toThrow(/full or reduced/);
  });

  it("defaults stay the untouched account record for a user who never saved", () => {
    expect(DEFAULT_PREFERENCES).toEqual({ timezone: "UTC", weekStart: 1, appearance: "system", motion: "full" });
  });
});
