import { describe, expect, it } from "vitest";
import { passageWindow } from "@/domains/knowledge/search";

describe("passageWindow", () => {
  const TEXT = "alpha intro. ".repeat(50) + "the security deposit is held by the landlord. " + "omega outro. ".repeat(50);

  it("centres the window on the earliest matching query term", () => {
    const { start, end } = passageWindow(TEXT, "security deposit");
    const at = TEXT.toLowerCase().indexOf("security");
    expect(start).toBe(Math.max(0, at - 600));
    expect(end).toBe(Math.min(TEXT.length, at + 600));
    // Offsets are real coordinates: slicing the text returns the passage.
    expect(TEXT.slice(start, end)).toContain("security deposit");
  });

  it("returns the head of the text when no term is present (stemmed matches need no raw term)", () => {
    expect(passageWindow(TEXT, "unrelatedwords")).toEqual({ start: 0, end: 1200 });
  });

  it("ignores very short terms and clamps at both ends", () => {
    const short = "security deposit near the start";
    const { start, end } = passageWindow(short, "security");
    expect(start).toBe(0);
    expect(end).toBe(short.length);
    expect(passageWindow(TEXT, "a an is")).toEqual({ start: 0, end: 1200 });
  });
});
