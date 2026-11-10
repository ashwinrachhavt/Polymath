import { describe, expect, it } from "vitest";
import { layoutMarginNotes } from "@/components/products/polymath/margin-layout";

describe("layoutMarginNotes", () => {
  it("keeps notes at their anchor when they fit", () => {
    const out = layoutMarginNotes([
      { key: "a", top: 0, height: 80 },
      { key: "b", top: 200, height: 80 },
    ]);
    expect(out.map((n) => n.top)).toEqual([0, 200]);
  });

  it("pushes an overlapping note below the previous one", () => {
    const out = layoutMarginNotes([
      { key: "a", top: 0, height: 80 },
      { key: "b", top: 40, height: 80 },
    ]);
    expect(out.map((n) => n.top)).toEqual([0, 92]);
  });

  it("hides notes past the cap", () => {
    const anchors = Array.from({ length: 14 }, (_, i) => ({ key: `k${i}`, top: i * 200, height: 80 }));
    const out = layoutMarginNotes(anchors);
    expect(out.filter((n) => !n.hidden)).toHaveLength(12);
    expect(out).toHaveLength(14);
  });
});
