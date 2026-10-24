import { describe, expect, it } from "vitest";
import { pruneSelection, toggleSelection } from "@/app/(workspace)/neuralflow/work/selection";

describe("work list selection", () => {
  it("toggles rows in selection order", () => {
    let selected: string[] = [];
    selected = toggleSelection(selected, "a");
    selected = toggleSelection(selected, "b");
    expect(selected).toEqual(["a", "b"]);
    expect(toggleSelection(selected, "a")).toEqual(["b"]);
    expect(toggleSelection(selected, "b")).toEqual(["a"]);
  });

  it("prunes rows that left the screen so an invisible id cannot ride into a bulk action", () => {
    expect(pruneSelection(["a", "b", "c"], new Set(["b", "c"]))).toEqual(["b", "c"]);
    expect(pruneSelection(["a"], new Set())).toEqual([]);
    expect(pruneSelection([], new Set(["a"]))).toEqual([]);
  });
});
