import { describe, expect, it } from "vitest";
import { sourceWindow } from "@/integrations/learning/source-window";

describe("sourceWindow", () => {
  const text = Array.from({ length: 30_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

  it("reads a source that fits in one window whole, for every batch", () => {
    expect(sourceWindow("short source", 9_000, 0)).toBe("short source");
    expect(sourceWindow("short source", 9_000, 3)).toBe("short source");
  });

  it("moves each batch to a different full-size slice that spans the whole source", () => {
    const windows = [0, 1, 2, 3].map((part) => sourceWindow(text, 9_000, part));
    for (const window of windows) expect(window).toHaveLength(9_000);
    // Evenly spaced from the start to the end, so neighbours overlap and leave no gap.
    expect(windows[0]).toBe(text.slice(0, 9_000));
    expect(windows[1]).toBe(text.slice(7_000, 16_000));
    expect(windows[2]).toBe(text.slice(14_000, 23_000));
    expect(windows[3]).toBe(text.slice(21_000));
  });

  it("wraps around after the last window", () => {
    expect(sourceWindow(text, 9_000, 4)).toBe(sourceWindow(text, 9_000, 0));
  });
});
