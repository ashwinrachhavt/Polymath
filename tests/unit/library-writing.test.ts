import { describe, expect, it } from "vitest";
import { parseLibraryDraft } from "@/domains/knowledge/library-writing";

/*
 * The library-draft parser is where invented authority dies: a citation that
 * points past the retrieved source list is the model borrowing trust it was
 * never given, and the whole answer is unusable rather than partially true.
 */

const ANSWER = JSON.stringify({
  title: "Annual billing",
  paragraphs: [
    { text: "Annual billing stays for the platform tier.", citations: [1], needsCitation: false },
    { text: "The market is moving toward usage pricing.", citations: [], needsCitation: true },
  ],
});

describe("parseLibraryDraft", () => {
  it("accepts a grounded answer with a flagged paragraph", () => {
    const draft = parseLibraryDraft(ANSWER, 2);
    expect(draft.paragraphs).toHaveLength(2);
    expect(draft.paragraphs[1]?.needsCitation).toBe(true);
  });

  it("rejects a citation the search never retrieved", () => {
    const invented = JSON.stringify({
      title: "T",
      paragraphs: [{ text: "Grounded in a source that does not exist.", citations: [2], needsCitation: false }],
    });
    expect(() => parseLibraryDraft(invented, 1)).toThrowError(/never retrieved/);
  });

  it("rejects a paragraph that both cites and asks for a citation", () => {
    const bad = JSON.stringify({
      title: "T",
      paragraphs: [{ text: "Hedged both ways.", citations: [1], needsCitation: true }],
    });
    expect(() => parseLibraryDraft(bad, 1)).toThrowError(/both cite/);
  });

  it("rejects non-JSON and wrong shapes", () => {
    expect(() => parseLibraryDraft("no", 1)).toThrowError(/not JSON/);
    expect(() => parseLibraryDraft(JSON.stringify({ title: "T", paragraphs: [] }), 1)).toThrowError(/did not match/);
  });
});
