import { describe, expect, it } from "vitest";
import {
  analyzePaste,
  locateSpan,
  PASTE_TOO_LONG,
  sourceHash,
} from "@/domains/knowledge/decomposition";
import { DECOMPOSE_MAX_CHARS, DECOMPOSE_PASTE_CHARS } from "@/domains/knowledge/sittings";

const TEXT = [
  "The queue drains oldest first.",
  "We chose Postgres for its transactional DDL.",
  "Steps: capture, triage, commit.",
].join("\n");

const raw = {
  candidates: [
    { role: "principle" as const, kind: "extraction" as const, title: "FIFO", content: "Queues drain oldest first.", quotes: ["The queue drains oldest first."] },
    { role: "decision" as const, kind: "extraction" as const, title: "Postgres", content: "Postgres was chosen for DDL.", quotes: ["We chose Postgres", "transactional DDL."] },
    { role: "checklist" as const, kind: "synthesis" as const, title: "Flow", content: "Capture then commit.", quotes: ["capture, triage, commit"] },
    { role: "principle" as const, kind: "extraction" as const, title: "Invented", content: "Made up.", quotes: ["this passage is not in the source"] },
  ],
  omitted: [
    { quote: "The queue drains oldest first.", reason: "already covered by a candidate" },
    { quote: "not really in the text", reason: "hallucinated omission" },
  ],
};

describe("decomposition (§4, §15.1)", () => {
  it("locates a verbatim span and rejects a quote that is not in the source", () => {
    expect(locateSpan(TEXT, "The queue drains oldest first.")).toEqual({ start: 0, end: 30, quote: "The queue drains oldest first." });
    expect(locateSpan(TEXT, "absent")).toBeNull();
  });

  it("keeps only candidates with at least one verbatim-locatable quote; multiple passages support one candidate", () => {
    const analysis = analyzePaste(TEXT, raw);
    expect(analysis.candidates.map((c) => c.title)).toEqual(["FIFO", "Postgres", "Flow"]);
    const pg = analysis.candidates[1];
    expect(pg.spans).toHaveLength(2); // multiple passages, one candidate
    expect(pg.role).toBe("decision"); // role routing survives analysis
    expect(analysis.candidates[2].kind).toBe("synthesis"); // extraction vs synthesis distinguished
  });

  it("surfaces omitted material only when the quote is real", () => {
    const analysis = analyzePaste(TEXT, raw);
    expect(analysis.omitted).toEqual([{ quote: "The queue drains oldest first.", reason: "already covered by a candidate" }]);
  });

  it("dedupe id is source+span stable across re-analysis", () => {
    const a = analyzePaste(TEXT, raw);
    const b = analyzePaste(TEXT, raw);
    expect(a.candidates.map((c) => c.id)).toEqual(b.candidates.map((c) => c.id));
    expect(a.sourceHash).toBe(sourceHash(TEXT));
  });

  it("rejects over-cap input, never truncates (§15.1 exact copy)", () => {
    const big = "x".repeat(DECOMPOSE_MAX_CHARS + 1);
    expect(() => analyzePaste(big, raw)).toThrowError(PASTE_TOO_LONG);
  });

  it("named constants keep their contracted values", () => {
    expect(DECOMPOSE_PASTE_CHARS).toBe(2000);
    expect(DECOMPOSE_MAX_CHARS).toBe(20000);
  });
});
