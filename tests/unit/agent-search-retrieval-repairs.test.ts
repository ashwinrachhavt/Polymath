// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SEARCH_PER_DOCUMENT_LIMIT,
  AGENT_SEARCH_SINGLE_LEG_MAX_RANK,
  isEvidence,
  rrfMerge,
  type ScoredHit,
} from "@/domains/knowledge/agent-search";
import type { ChunkHit } from "@/domains/knowledge/search";

/*
 * Regression pins for issue #533 findings 1, 3, 4 (fusion identity is pinned
 * in the integration suite where Postgres ranks real rows).
 */

vi.mock("@/domains/knowledge/search", () => ({
  searchChunks: vi.fn(),
  searchChunksFts: vi.fn(),
}));

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

describe("finding 1: one document may contribute several distinct passages", () => {
  it("keeps distant sections of one document up to the per-document budget", () => {
    const fts = [0, 1, 2, 3].map((i) => hit("doc-a", { chunkIndex: i, text: `section ${i}` }));
    const vector = [hit("doc-b")];
    const merged = rrfMerge(fts, vector, 10, { legsRun: 2 });
    const fromA = merged.filter((h) => h.documentId === "doc-a");
    expect(fromA.length).toBe(AGENT_SEARCH_PER_DOCUMENT_LIMIT);
    expect(merged.some((h) => h.documentId === "doc-b")).toBe(true);
  });

  it("still bounds a repeated-text document so it cannot crowd others out", () => {
    const fts = Array.from({ length: 8 }, (_, i) => hit("spam", { chunkIndex: i }));
    const vector = [hit("real-1"), hit("real-2")];
    const merged = rrfMerge(fts, vector, 10, { legsRun: 2 });
    expect(merged.filter((h) => h.documentId === "spam").length).toBe(AGENT_SEARCH_PER_DOCUMENT_LIMIT);
  });

  it("honors a caller-set budget", () => {
    const fts = [0, 1, 2].map((i) => hit("doc-a", { chunkIndex: i }));
    const merged = rrfMerge(fts, [], 10, { perDocumentLimit: 1 });
    expect(merged.length).toBe(1);
  });
});

// EXPERIMENTAL, HARNESS-ONLY (issue #533 finding 3 is NOT repaired in
// production): these pin the behavior of the candidate rank-provenance rule
// the eval harness measures. searchDocumentsForAgent still admits by the
// fused-score floor - the candidate regressed precision and never abstained
// on the draft set, so it must not ship without validated improvement.
describe("finding 3 (experimental candidate, harness-only): rank provenance vs fused score", () => {
  const scored = (legs: ("fts" | "vector")[], bestRank: { fts?: number; vector?: number }): ScoredHit => ({
    ...hit("x"),
    fusedScore: 0.1,
    legs,
    bestRank,
  });

  it("admits what both legs saw, at any rank", () => {
    expect(isEvidence(scored(["fts", "vector"], { fts: 40, vector: 49 }))).toBe(true);
  });

  it("admits a single-leg hit at the top of its leg - the old floor dropped rank 1", () => {
    expect(isEvidence(scored(["fts"], { fts: 0 }))).toBe(true);
    expect(isEvidence(scored(["vector"], { vector: AGENT_SEARCH_SINGLE_LEG_MAX_RANK }))).toBe(true);
  });

  it("counterexample: rank provenance can override score ordering", () => {
    // A single-leg hit at rank 3 OUTSCORES a dual-leg hit both legs placed
    // at rank 100 (30/63 > 2 * 30/160), yet admission flips: the dual-leg
    // hit is evidence (two independent retrievers agree) and the single-leg
    // hit is not. Score ordering and evidence admission are separate
    // decisions - this is the case the old fused-score floor got backwards.
    const deep = rrfMerge([hit("both", { chunkIndex: 7 })], [hit("both", { chunkIndex: 7 })], 10, { legsRun: 2 });
    // Manufacture the deep-rank provenance directly: rrfMerge of rank-0
    // lists cannot place a hit at rank 100, so assert the rule itself.
    const deepDual: ScoredHit = { ...hit("both", { chunkIndex: 7 }), fusedScore: 2 * (60 / 2 / (60 + 100)), legs: ["fts", "vector"], bestRank: { fts: 100, vector: 100 } };
    const shallowSingle: ScoredHit = { ...hit("solo"), fusedScore: 60 / 1 / (60 + 3), legs: ["fts"], bestRank: { fts: 3 } };
    expect(shallowSingle.fusedScore).toBeGreaterThan(deepDual.fusedScore);
    expect(isEvidence(deepDual)).toBe(true);
    expect(isEvidence(shallowSingle)).toBe(false);
    expect(deep.length).toBe(1);
  });

  it("drops a single-leg hit past the provisional rank bound", () => {
    expect(isEvidence(scored(["fts"], { fts: AGENT_SEARCH_SINGLE_LEG_MAX_RANK + 1 }))).toBe(false);
  });

  it("rrfMerge records which legs saw each hit and their best ranks", () => {
    const merged = rrfMerge([hit("a"), hit("b")], [hit("b"), hit("a")], 10, { legsRun: 2 });
    const a = merged.find((h) => h.documentId === "a")!;
    expect(a.legs.sort()).toEqual(["fts", "vector"]);
    expect(a.bestRank).toEqual({ fts: 0, vector: 1 });
  });
});

describe("finding 4: legs fail independently", () => {
  const auth = { userId: "u", workspaceId: "w", role: "owner" } as never;

  it("a transient vector error degrades to labeled text mode instead of failing the search", async () => {
    const { searchChunks, searchChunksFts } = await import("@/domains/knowledge/search");
    const { searchDocumentsForAgent } = await import("@/domains/knowledge/agent-search");
    vi.mocked(searchChunks).mockRejectedValueOnce(new Error("embedding API 503"));
    vi.mocked(searchChunksFts).mockResolvedValueOnce([hit("survivor")]);
    const result = await searchDocumentsForAgent(auth, { query: "roadmap" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("text");
      expect(result.degraded).toBe("vector_leg_failed");
      expect(result.results[0]?.documentId).toBe("survivor");
    }
  });

  it("a transient fts error degrades to labeled semantic mode", async () => {
    const { searchChunks, searchChunksFts } = await import("@/domains/knowledge/search");
    const { searchDocumentsForAgent } = await import("@/domains/knowledge/agent-search");
    vi.mocked(searchChunks).mockResolvedValueOnce([hit("semantic-survivor")]);
    vi.mocked(searchChunksFts).mockRejectedValueOnce(new Error("postgres restarted"));
    const result = await searchDocumentsForAgent(auth, { query: "roadmap" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("semantic");
      expect(result.degraded).toBe("fts_leg_failed");
    }
  });

  it("both legs failing is an error, never a silent empty list", async () => {
    const { searchChunks, searchChunksFts } = await import("@/domains/knowledge/search");
    const { searchDocumentsForAgent } = await import("@/domains/knowledge/agent-search");
    vi.mocked(searchChunks).mockRejectedValueOnce(new Error("embedding API 503"));
    vi.mocked(searchChunksFts).mockRejectedValueOnce(new Error("postgres restarted"));
    const result = await searchDocumentsForAgent(auth, { query: "roadmap" });
    expect(result.ok).toBe(false);
  });

  it("citations carry passage lineage (finding 6)", async () => {
    const { searchChunks, searchChunksFts } = await import("@/domains/knowledge/search");
    const { searchDocumentsForAgent } = await import("@/domains/knowledge/agent-search");
    vi.mocked(searchChunks).mockResolvedValueOnce([hit("doc", { extractionId: "ex-9", chunkIndex: 4 })]);
    vi.mocked(searchChunksFts).mockResolvedValueOnce([hit("doc", { extractionId: "ex-9", chunkIndex: 4 })]);
    const result = await searchDocumentsForAgent(auth, { query: "roadmap" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0]?.extractionId).toBe("ex-9");
      expect(result.results[0]?.chunkIndex).toBe(4);
    }
  });
});
