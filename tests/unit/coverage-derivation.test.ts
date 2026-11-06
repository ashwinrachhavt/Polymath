import { describe, expect, it } from "vitest";
import { MAX_CHUNKS } from "@/domains/knowledge/chunking";
import { deriveCoverage } from "@/domains/knowledge/coverage";

/*
 * The finding-5 contract: "complete" must be PROVEN, "partial" must be
 * PROVEN, and everything else is "unknown" - never a falsely reassuring
 * complete (issue #533, owner review 2026-11-06).
 */
describe("deriveCoverage", () => {
  const base = { embedModel: "m1", embedError: null, textLength: 10_000 };

  it("complete when chunks reach the text end - including the endpoint-touching boundary", () => {
    expect(deriveCoverage({ ...base, chunks: { count: 9, maxSpanEnd: 10_000 } })).toBe("complete");
    expect(deriveCoverage({ ...base, chunks: { count: 9, maxSpanEnd: 10_001 } })).toBe("complete");
  });

  it("exactly MAX_CHUNKS, fully covered: complete - the cap count alone proves nothing", () => {
    expect(deriveCoverage({ ...base, chunks: { count: MAX_CHUNKS, maxSpanEnd: 10_000 } })).toBe("complete");
  });

  it("exactly MAX_CHUNKS, truncated: partial - the cap cut the tail", () => {
    expect(deriveCoverage({ ...base, chunks: { count: MAX_CHUNKS, maxSpanEnd: 9_999 } })).toBe("partial");
    expect(deriveCoverage({ ...base, chunks: { count: MAX_CHUNKS + 3, maxSpanEnd: 5_000 } })).toBe("partial");
  });

  it("a shorter interrupted run (gap without the cap): unknown, never complete", () => {
    expect(deriveCoverage({ ...base, chunks: { count: 3, maxSpanEnd: 3_600 } })).toBe("unknown");
  });

  it("no chunks at all: unknown", () => {
    expect(deriveCoverage({ ...base, chunks: { count: 0, maxSpanEnd: null } })).toBe("unknown");
  });

  it("a recorded failure on the last pass: unknown even with complete-looking chunks", () => {
    expect(
      deriveCoverage({ ...base, embedError: "embedding failed, retry queued", chunks: { count: 9, maxSpanEnd: 10_000 } }),
    ).toBe("unknown");
  });

  it("no recorded model (legacy provenance): unknown even with chunks present", () => {
    // The caller aggregates chunks for embedModel only; a null model means no
    // aggregates and no provenance.
    expect(deriveCoverage({ ...base, embedModel: null, chunks: { count: 0, maxSpanEnd: null } })).toBe("unknown");
  });

  it("stale rows of another model: the caller aggregates by embedModel, so they count as no chunks: unknown", () => {
    // Wiring rule pinned at the unit level: only embedModel's rows may reach
    // deriveCoverage. A mismatch arrives as count 0.
    expect(deriveCoverage({ ...base, chunks: { count: 0, maxSpanEnd: null } })).toBe("unknown");
  });

  it("one character short of the end without the cap: unknown, not complete", () => {
    expect(deriveCoverage({ ...base, chunks: { count: 9, maxSpanEnd: 9_999 } })).toBe("unknown");
  });
});
