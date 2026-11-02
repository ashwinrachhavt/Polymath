import { describe, expect, it } from "vitest";
import { cosineDistance, isDuplicateDistance, quotesOverlap } from "@/domains/knowledge/zettels";

/*
 * The overlap measures behind the re-zettelize dedup: quote containment is
 * exact (every proposal quote is a verbatim span of one source text), and the
 * claim distance is the same cosine the corpus dedup uses. Together they must
 * catch a re-chunked repeat that the span-key index cannot see.
 */

describe("quotesOverlap", () => {
  const FULL = "Rent is due on the first of each month.";

  it("sees a re-chunked sub-span inside the original quote", () => {
    expect(quotesOverlap(FULL, "of each month.")).toBe(true);
    expect(quotesOverlap("Rent is due on the first", FULL)).toBe(true);
  });

  it("tolerates whitespace differences at the edges and inside", () => {
    expect(quotesOverlap(`  Rent is due\non the first of each month.  `, FULL)).toBe(true);
  });

  it("does not fire on a shifted window that only overlaps", () => {
    expect(quotesOverlap(FULL, "of each month. The deposit is protected.")).toBe(false);
  });

  it("does not fire on disjoint passages", () => {
    expect(quotesOverlap(FULL, "The deposit is protected until move out.")).toBe(false);
  });

  it("an empty quote overlaps nothing", () => {
    expect(quotesOverlap(FULL, "   ")).toBe(false);
    expect(quotesOverlap("", "")).toBe(false);
  });
});

describe("cosineDistance", () => {
  it("identical vectors sit at distance zero", () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0);
  });

  it("orthogonal vectors sit at distance one", () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
  });

  it("opposite vectors sit at distance two", () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2);
  });

  it("the zero vector is never a duplicate", () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
    expect(isDuplicateDistance(cosineDistance([0, 0], [1, 1]))).toBe(false);
  });

  it("feeds the same 0.15 threshold the corpus dedup uses", () => {
    const d = cosineDistance([1, 1], [2, 2]); // same direction, different magnitude
    expect(d).toBeCloseTo(0);
    expect(isDuplicateDistance(d)).toBe(true);
  });
});
