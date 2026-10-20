import { describe, expect, it } from "vitest";
import { passageTitle, segmentText, type Passage } from "@/domains/knowledge/passages";

const p = (quote: string): Passage => ({ artifactId: "a", title: "t", quote });

describe("segmentText", () => {
  it("marks a saved quote that still appears verbatim", () => {
    const out = segmentText("one two three four", [p("two three")]);
    expect(out.map((s) => [s.text, s.passage !== null])).toEqual([
      ["one ", false],
      ["two three", true],
      [" four", false],
    ]);
  });
  it("skips a quote that no longer appears and overlapping quotes", () => {
    expect(segmentText("alpha beta", [p("gone")])).toEqual([{ text: "alpha beta", passage: null }]);
    const out = segmentText("alpha beta gamma", [p("alpha beta"), p("beta gamma")]);
    expect(out.filter((s) => s.passage)).toHaveLength(1);
  });
});

describe("passageTitle", () => {
  it("flattens whitespace and truncates long quotes", () => {
    expect(passageTitle("a  b\nc")).toBe("a b c");
    expect(passageTitle("x".repeat(100))).toHaveLength(70);
  });
});
