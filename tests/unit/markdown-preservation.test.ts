import { describe, expect, it } from "vitest";
import { markdownEditorMode, markdownSourceReason } from "@/components/products/alfred/markdown-preservation";

/*
 * These cases pin the boundary that broke: angle brackets are ordinary prose,
 * and treating every `<word>` as an HTML tag blocked pasting addresses,
 * generics, and autolinks into a note.
 */
describe("markdownSourceReason", () => {
  it("leaves ordinary prose alone", () => {
    for (const text of [
      "Today I reviewed the onboarding flow.",
      "Ping <ashwin@example.com> when done.",
      "Use Array<string> and Map<K, V>.",
      "If x < 5 and y > 2 then stop.",
      "Ask <https://example.com/notes> for the source.",
      "Notes:\n- first point\n- second point",
      "A pipe | inside prose is fine.",
    ]) {
      expect(markdownSourceReason(text), text).toBeUndefined();
    }
  });

  it("still names constructs the rich editor cannot keep", () => {
    expect(markdownSourceReason("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe("tables");
    expect(markdownSourceReason("![alt](https://x.com/a.png)")).toBe("images");
    expect(markdownSourceReason("- [ ] unfinished")).toBe("task checkbox states");
    expect(markdownSourceReason("[ref]: https://x.com")).toBe("reference links, images or footnotes");
    expect(markdownSourceReason("text[^1]\n\n[^1]: a note")).toBe("reference links, images or footnotes");
  });

  it("recognises real HTML elements and tags with attributes", () => {
    for (const text of [
      "<div>block</div>",
      "<br>",
      "<!-- editorial note -->",
      '<a href="https://x.com">link</a>',
      '<img src="x.png">',
      "<table><tr><td>1</td></tr></table>",
    ]) {
      expect(markdownSourceReason(text), text).toBe("raw HTML");
    }
  });

  it("opens a document holding raw HTML in source mode", () => {
    expect(markdownEditorMode("<div>block</div>")).toBe("source");
    expect(markdownEditorMode("Ping <ashwin@example.com>")).toBe("rich");
  });
});
