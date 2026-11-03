import { describe, expect, it } from "vitest";
import {
  SUGGESTED_LINKS_PER_COLLECTION_CARD,
  SUGGESTED_LINKS_PER_DETAIL_PAGE,
  capForSize,
} from "@/domains/knowledge/zettel-capacity";

describe("capForSize", () => {
  it("caps a small capture at 2, boundary inclusive", () => {
    expect(capForSize(0)).toBe(2);
    expect(capForSize(1_500)).toBe(2);
    expect(capForSize(2_000)).toBe(2);
  });

  it("moves to 5 one character past the small band", () => {
    expect(capForSize(2_001)).toBe(5);
  });

  it("caps a medium post at 5, boundary inclusive", () => {
    expect(capForSize(6_000)).toBe(5);
    expect(capForSize(12_000)).toBe(5);
  });

  it("moves to 8 one character past the medium band", () => {
    expect(capForSize(12_001)).toBe(8);
  });

  it("holds 8 for a long multi-section source", () => {
    expect(capForSize(140_000)).toBe(8);
  });
});

describe("the suggested-link caps", () => {
  it("are 3 per collection card and 5 per detail page", () => {
    expect(SUGGESTED_LINKS_PER_COLLECTION_CARD).toBe(3);
    expect(SUGGESTED_LINKS_PER_DETAIL_PAGE).toBe(5);
  });
});
