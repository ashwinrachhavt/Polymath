import { describe, expect, it } from "vitest";
import { mergePaletteResults } from "@/components/shell/palette-merge";

/*
 * The palette's two phases merge on the client: title matches answer first,
 * the knowledge ranking streams in behind. A hit must never appear twice,
 * and each phase keeps its own order.
 */
describe("mergePaletteResults", () => {
  it("appends only rows the base does not already have, keeping both orders", () => {
    const base = [{ key: "a" }, { key: "b" }];
    const extra = [{ key: "b" }, { key: "c" }, { key: "d" }];
    expect(mergePaletteResults(base, extra)).toEqual([{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }]);
  });

  it("returns the base untouched when the second phase found nothing new", () => {
    const base = [{ key: "a" }];
    expect(mergePaletteResults(base, [])).toEqual(base);
    expect(mergePaletteResults([], [{ key: "c" }])).toEqual([{ key: "c" }]);
  });
});
