import { describe, expect, it } from "vitest";
import { MAX_CHUNKS } from "@/domains/knowledge/chunking";
import { deriveCoverage, type CoverageInput } from "@/domains/knowledge/coverage";

/** A plausible aggregate: contiguous indices, head at text start, tail covered. */
function chunks(over: Partial<CoverageInput["chunks"]> = {}): CoverageInput["chunks"] {
  return { count: 3, minIndex: 0, maxIndex: 2, minSpanStart: 0, maxSpanEnd: 100, ...over };
}

function input(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    embedModel: "fake:hash-1536",
    embedError: null,
    textLength: 100,
    leadingWhitespace: 0,
    chunks: chunks(),
    ...over,
  };
}

describe("deriveCoverage", () => {
  it("complete when contiguous chunks cover head to trimmed tail", () => {
    expect(deriveCoverage(input())).toBe("complete");
  });

  it("complete on the exact endpoint-touching boundary (maxSpanEnd === textLength)", () => {
    expect(deriveCoverage(input({ chunks: chunks({ maxSpanEnd: 100 }) }))).toBe("complete");
  });

  it("complete when exactly MAX_CHUNKS chunks provably cover the whole text", () => {
    expect(
      deriveCoverage(input({ chunks: chunks({ count: MAX_CHUNKS, maxIndex: MAX_CHUNKS - 1, maxSpanEnd: 100 }) })),
    ).toBe("complete");
  });

  it("partial when exactly MAX_CHUNKS contiguous chunks stop before the tail", () => {
    expect(
      deriveCoverage(input({ textLength: 999_999, chunks: chunks({ count: MAX_CHUNKS, maxIndex: MAX_CHUNKS - 1, maxSpanEnd: 40_000 }) })),
    ).toBe("partial");
  });

  it("unknown when a shorter run stopped early without the cap (interrupted)", () => {
    expect(deriveCoverage(input({ textLength: 999_999, chunks: chunks({ maxSpanEnd: 40_000 }) }))).toBe("unknown");
  });

  it("unknown when no chunks exist for the recorded model", () => {
    expect(deriveCoverage(input({ chunks: { count: 0, minIndex: null, maxIndex: null, minSpanStart: null, maxSpanEnd: null } }))).toBe("unknown");
  });

  it("unknown when the last pass failed (embedError recorded)", () => {
    expect(deriveCoverage(input({ embedError: "embedding failed, retry queued" }))).toBe("unknown");
  });

  it("unknown when chunks exist under another (stale) model only", () => {
    // coverageFor finds no rows for the CURRENT embedModel, so count is 0.
    expect(deriveCoverage(input({ chunks: { count: 0, minIndex: null, maxIndex: null, minSpanStart: null, maxSpanEnd: null } }))).toBe("unknown");
  });

  it("unknown when no model provenance is recorded (legacy rows)", () => {
    expect(deriveCoverage(input({ embedModel: null }))).toBe("unknown");
  });

  it("unknown when one character past the last chunk is uncovered without the cap", () => {
    expect(deriveCoverage(input({ textLength: 101, chunks: chunks({ maxSpanEnd: 100 }) }))).toBe("unknown");
  });

  it("unknown when a MIDDLE chunk is missing even though the last chunk reaches the tail", () => {
    // 3 rows at indices 0, 1, 3: hole at 2, endpoint present. max != count-1.
    expect(deriveCoverage(input({ chunks: chunks({ count: 3, maxIndex: 3 }) }))).toBe("unknown");
  });

  it("unknown when the FIRST chunk is missing even though the last chunk reaches the tail", () => {
    expect(deriveCoverage(input({ chunks: chunks({ count: 2, minIndex: 1, maxIndex: 2 }) }))).toBe("unknown");
  });

  it("unknown on duplicate/extra rows (count larger than the index range allows)", () => {
    expect(deriveCoverage(input({ chunks: chunks({ count: 5, maxIndex: 2 }) }))).toBe("unknown");
  });

  it("complete when chunk 0 starts inside the text's leading whitespace", () => {
    expect(deriveCoverage(input({ leadingWhitespace: 4, chunks: chunks({ minSpanStart: 3 }) }))).toBe("complete");
  });

  it("unknown when the head is uncovered past the leading whitespace", () => {
    expect(deriveCoverage(input({ leadingWhitespace: 0, chunks: chunks({ minSpanStart: 50 }) }))).toBe("unknown");
  });

  it("unknown (not partial) when a capped pass has a broken index set", () => {
    expect(
      deriveCoverage(input({ textLength: 999_999, chunks: chunks({ count: MAX_CHUNKS, maxIndex: MAX_CHUNKS, maxSpanEnd: 40_000 }) })),
    ).toBe("unknown");
  });
});
