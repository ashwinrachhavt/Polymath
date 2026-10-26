import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, resolveInterfaceMode, validatePreferencePatch } from "@/domains/identity/preferences";

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

  it("rejects unknown appearance, motion and interface mode values", () => {
    expect(() => validatePreferencePatch({ appearance: "purple" as never })).toThrow(/light, dark or system/);
    expect(() => validatePreferencePatch({ motion: "spinning" as never })).toThrow(/full or reduced/);
    expect(() => validatePreferencePatch({ interfaceMode: "flashy" as never })).toThrow(/library, action or auto/);
  });

  it("defaults stay the untouched account record for a user who never saved", () => {
    expect(DEFAULT_PREFERENCES).toEqual({ timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", interfaceMode: "auto" });
  });
});

describe("resolveInterfaceMode (ASH-312)", () => {
  // Fixed instant: 2026-10-25 16:00 UTC - 09:00 in Los Angeles (PDT), 02:00
  // the next day in Sydney (AEDT).
  const at = new Date("2026-10-25T16:00:00Z");

  it("explicit modes pass through whatever the hour", () => {
    expect(resolveInterfaceMode("library", "America/Los_Angeles", at)).toBe("library");
    expect(resolveInterfaceMode("action", "America/Los_Angeles", at)).toBe("action");
  });

  it("auto resolves by the saved timezone's working day (08:00-18:00 -> action)", () => {
    expect(resolveInterfaceMode("auto", "America/Los_Angeles", at)).toBe("action");
    expect(resolveInterfaceMode("auto", "Australia/Sydney", at)).toBe("library");
    expect(resolveInterfaceMode("auto", "UTC", at)).toBe("action");
  });

  it("the boundaries are inclusive at 08:00 and exclusive at 18:00", () => {
    expect(resolveInterfaceMode("auto", "UTC", new Date("2026-10-25T08:00:00Z"))).toBe("action");
    expect(resolveInterfaceMode("auto", "UTC", new Date("2026-10-25T17:59:59Z"))).toBe("action");
    expect(resolveInterfaceMode("auto", "UTC", new Date("2026-10-25T18:00:00Z"))).toBe("library");
    expect(resolveInterfaceMode("auto", "UTC", new Date("2026-10-25T07:59:59Z"))).toBe("library");
  });

  it("an unrecognised timezone falls back to UTC rather than throwing", () => {
    expect(resolveInterfaceMode("auto", "Mars/Olympus_Mons", at)).toBe(resolveInterfaceMode("auto", "UTC", at));
  });
});
