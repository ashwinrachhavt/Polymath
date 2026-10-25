import { describe, expect, it } from "vitest";
import { rrfMerge } from "@/domains/knowledge/agent-search";
import type { ChunkHit } from "@/domains/knowledge/search";

const hit = (id: string, over: Partial<ChunkHit> = {}): ChunkHit => ({
  documentId: id,
  title: id,
  extractionId: `ex-${id}`,
  chunkIndex: 0,
  text: `text of ${id}`,
  span: { start: 0, end: 10, page: null },
  distance: 0,
  ...over,
});

describe("rrfMerge", () => {
  it("sums 1/(60+rank) from both sides and sorts by fused score", () => {
    const fts = [hit("a"), hit("b"), hit("c")];
    const vector = [hit("b"), hit("d"), hit("a")];
    const merged = rrfMerge(fts, vector, 10);
    // a: 1/61 + 1/63; b: 1/62 + 1/61; d: 1/61 (vector rank 1); c: 1/62 (fts rank 2).
    expect(merged.map((h) => h.documentId)).toEqual(["b", "a", "d", "c"]);
  });

  it("a hit seen by only one side still appears (never drops to zero)", () => {
    const merged = rrfMerge([hit("only-fts")], [], 10);
    expect(merged.map((h) => h.documentId)).toEqual(["only-fts"]);
    expect(rrfMerge([], [hit("only-vector")], 10).map((h) => h.documentId)).toEqual(["only-vector"]);
  });

  it("keeps the hit object from the side that saw it, preserving span and text", () => {
    const fts = [hit("x", { text: "fts passage", span: { start: 12, end: 34, page: 2 } })];
    const vector = [hit("x", { text: "vector passage", span: { start: 0, end: 9, page: 1 } })];
    const merged = rrfMerge(fts, vector, 10);
    expect(merged).toHaveLength(1);
    // First side wins on collision: the FTS passage is the keyword evidence.
    expect(merged[0].text).toBe("fts passage");
    expect(merged[0].span).toEqual({ start: 12, end: 34, page: 2 });
  });

  it("slices to the requested limit after sorting", () => {
    const fts = [hit("a"), hit("b"), hit("c"), hit("d")];
    const vector = [hit("e"), hit("f")];
    // a (1/61) ties e (1/61): stable order puts the first side first.
    expect(rrfMerge(fts, vector, 3).map((h) => h.documentId)).toEqual(["a", "e", "b"]);
  });

  it("handles both sides empty", () => {
    expect(rrfMerge([], [], 5)).toEqual([]);
  });
});
