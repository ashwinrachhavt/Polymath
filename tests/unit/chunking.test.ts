import { describe, expect, it } from "vitest";
import { chunkText } from "@/domains/knowledge/chunking";

const sentence = "The tenant pays rent on the first of every month. ";

describe("chunkText", () => {
  it("returns nothing for blank text and one chunk for short text", () => {
    expect(chunkText("  \n ")).toEqual([]);
    expect(chunkText("Short.")).toEqual([{ index: 0, text: "Short.", start: 0, end: 6, page: null }]);
  });

  it("chunks stay near the target, end on sentence breaks, and overlap", () => {
    const text = sentence.repeat(80);
    const chunks = chunkText(text, [], { target: 500, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
      expect(c.text.endsWith(".")).toBe(true);
    }
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBeLessThan(chunks[i - 1].end);
  });

  it("offsets point at the exact text, so a hit can open its evidence", () => {
    const text = `Intro paragraph.\n\n${sentence.repeat(40)}\n\nClosing words here.`;
    for (const c of chunkText(text, [], { target: 300, overlap: 50 })) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it("prefers a paragraph break over a sentence break", () => {
    const text = `${"a ".repeat(120)}\n\n${"b ".repeat(120)}`;
    const [first] = chunkText(text, [], { target: 300, overlap: 20 });
    expect(first.text.endsWith("a")).toBe(true);
  });

  it("assigns the page from the span the chunk starts in", () => {
    const page1 = "one ".repeat(100);
    const page2 = "two ".repeat(100);
    const text = `${page1}\n\n${page2}`;
    const spans = [
      { page: 1, start: 0, end: page1.length },
      { page: 2, start: page1.length + 2, end: text.length },
    ];
    const pages = chunkText(text, spans, { target: 150, overlap: 10 }).map((c) => c.page);
    expect(pages[0]).toBe(1);
    expect(pages.at(-1)).toBe(2);
  });

  it("always terminates, even on text with no break points", () => {
    expect(chunkText("x".repeat(5000), [], { target: 400, overlap: 399 }).length).toBeGreaterThan(10);
  });

  it("caps the number of chunks", () => {
    expect(chunkText(sentence.repeat(500), [], { target: 200, overlap: 20, max: 7 })).toHaveLength(7);
  });
});
