import { describe, expect, it } from "vitest";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { numberedCitations, splitCitations } from "@/domains/knowledge/inline-citations";
import { answerToMarkdown } from "@/domains/knowledge/save-answer";

function citation(documentId: string, start = 0, title = "Doc"): DocumentCitation {
  return { documentId, title, text: "passage text", span: { start, end: start + 10, page: null } };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("splitCitations", () => {
  it("turns [[n]] into a citation segment", () => {
    const segments = splitCitations("The ease factor grows intervals [[1]].", [citation(A)]);
    expect(segments.map((s) => s.type)).toEqual(["text", "citation", "text"]);
    const cite = segments.find((s) => s.type === "citation");
    if (cite?.type !== "citation") throw new Error("shape");
    expect(cite.index).toBe(0);
    expect(cite.citation.documentId).toBe(A);
  });

  it("accepts a bare [n] marker", () => {
    const segments = splitCitations("Claim [2].", [citation(A), citation(B, 5)]);
    const cite = segments.find((s) => s.type === "citation");
    if (cite?.type !== "citation") throw new Error("shape");
    expect(cite.index).toBe(1);
    expect(cite.citation.documentId).toBe(B);
  });

  it("drops a marker that names no citation", () => {
    const segments = splitCitations("Unsupported claim [[9]].", [citation(A)]);
    expect(segments.every((s) => s.type === "text")).toBe(true);
    // The marker is removed rather than left as literal brackets: a [[9]] with
    // no source in the list reads as a citation that goes nowhere, which is
    // worse than none. The claim's own text survives.
    const text = segments.map((s) => (s.type === "text" ? s.text : "")).join("");
    expect(text).not.toContain("[[9]]");
    expect(text).toContain("Unsupported claim");
  });

  it("returns the whole answer as one segment when there are no citations", () => {
    const segments = splitCitations("No sources here.", []);
    expect(segments).toEqual([{ type: "text", text: "No sources here." }]);
  });

  it("keeps multiple markers in order", () => {
    const segments = splitCitations("One [[1]] and two [[2]].", [citation(A), citation(B, 5)]);
    const indices = segments.filter((s) => s.type === "citation").map((s) => (s.type === "citation" ? s.index : -1));
    expect(indices).toEqual([0, 1]);
  });
});

describe("numberedCitations", () => {
  it("numbers by first-seen document span and drops repeats", () => {
    const list = numberedCitations([citation(A), citation(A), citation(B, 5)]);
    expect(list).toHaveLength(2);
    expect(list[0].index).toBe(0);
    expect(list[1].citation.documentId).toBe(B);
  });

  it("keeps two spans of one document as separate citations", () => {
    const list = numberedCitations([citation(A, 0), citation(A, 100)]);
    expect(list).toHaveLength(2);
  });
});

describe("answerToMarkdown", () => {
  it("appends a numbered source list", () => {
    const text = answerToMarkdown("The answer.", [citation(A, 0, "Spacing"), citation(B, 5, "Memory")]);
    expect(text).toContain("The answer.");
    expect(text).toContain("1. Spacing");
    expect(text).toContain("2. Memory");
  });

  it("includes a page when the citation has one", () => {
    const pageCitation: DocumentCitation = { ...citation(A), span: { start: 0, end: 5, page: 12 } };
    expect(answerToMarkdown("x", [pageCitation])).toContain("(p. 12)");
  });

  it("returns the answer alone when there are no citations", () => {
    expect(answerToMarkdown("  Just this.  ", [])).toBe("Just this.");
  });
});
