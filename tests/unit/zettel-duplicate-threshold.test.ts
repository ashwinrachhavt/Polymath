import { describe, expect, it } from "vitest";
import { ZETTEL_DUPLICATE_MAX_DISTANCE, isDuplicateDistance } from "@/domains/knowledge/zettels";
import { SEMANTIC_EDGE_MAX_DISTANCE } from "@/domains/knowledge/relations";

describe("ZETTEL_DUPLICATE_MAX_DISTANCE", () => {
  it("is the calibrated 0.15", () => {
    expect(ZETTEL_DUPLICATE_MAX_DISTANCE).toBe(0.15);
  });
  it("is much tighter than the related-neighbour threshold", () => {
    expect(ZETTEL_DUPLICATE_MAX_DISTANCE).toBeLessThan(SEMANTIC_EDGE_MAX_DISTANCE / 2);
  });
  it("calls a tight pair a duplicate and a merely-related pair not one", () => {
    expect(isDuplicateDistance(0.08)).toBe(true);
    expect(isDuplicateDistance(0.3)).toBe(false);
    expect(isDuplicateDistance(0.15)).toBe(true);
  });
});
