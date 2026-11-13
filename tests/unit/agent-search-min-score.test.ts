import { describe, expect, it } from "vitest";
import { AGENT_SEARCH_MIN_SCORE, relevantByJudge, rrfMerge } from "@/domains/knowledge/agent-search";
import type { ChunkHit } from "@/domains/knowledge/search";

const hit = (id: string): ChunkHit => ({
  documentId: id,
  title: id,
  extractionId: `ex-${id}`,
  chunkIndex: 0,
  text: `text of ${id}`,
  span: { start: 0, end: 10, page: null },
  distance: 0,
});

describe("AGENT_SEARCH_MIN_SCORE", () => {
  it("is the calibrated 0.5 and sits on the normalized 0-1 fused scale", () => {
    expect(AGENT_SEARCH_MIN_SCORE).toBe(0.5);
  });

  it("keeps a genuine match both legs agree on and drops a keyword-only non-match", () => {
    // The genuine match is found by both legs near the top; the non-match shares
    // a stem with the query so only the keyword leg returns it, at rank 4.
    const fts = [hit("genuine"), hit("x1"), hit("x2"), hit("x3"), hit("non-match")];
    const vector = [hit("genuine"), hit("v1")];
    const merged = rrfMerge(fts, vector, 10, { legsRun: 2 });
    const score = (id: string) => merged.find((h) => h.documentId === id)!.fusedScore;
    expect(score("genuine")).toBeGreaterThanOrEqual(AGENT_SEARCH_MIN_SCORE);
    expect(score("non-match")).toBeLessThan(AGENT_SEARCH_MIN_SCORE);
  });

  it("keeps every text-mode hit, because one leg cannot outvote itself", () => {
    const merged = rrfMerge([hit("a"), hit("b"), hit("c")], [], 3, { legsRun: 1 });
    expect(merged.every((h) => h.fusedScore >= AGENT_SEARCH_MIN_SCORE)).toBe(true);
  });
});

describe("the Jev relevance check", () => {
  const scored = rrfMerge([hit("lease"), hit("aws")], [], 5, { legsRun: 1 });
  const judgeSaying = (keep: Record<string, number>) => ({
    judge: async () => ({
      model: "jev-test",
      answers: Object.fromEntries(Object.entries(keep).map(([key, noul]) => [key, { type: "noul" as const, noul }])),
      usage: { input_tokens: 1, output_tokens: 0 },
    }),
  });

  it("keeps only the passages Jev says help answer the query", async () => {
    const kept = await relevantByJudge(judgeSaying({ p0: 0.9, p1: 0.1 }), "rent", scored);
    expect(kept?.map((h) => h.documentId)).toEqual(["lease"]);
  });

  it("drops everything when nothing helps, so an unanswerable query comes back empty", async () => {
    expect(await relevantByJudge(judgeSaying({ p0: 0.2, p1: 0.1 }), "car insurance", scored)).toEqual([]);
  });

  it("returns null when Jev cannot answer, so the caller falls back to the score floor", async () => {
    const failing = { judge: async () => Promise.reject(new Error("quota")) };
    expect(await relevantByJudge(failing, "rent", scored)).toBeNull();
  });
});
