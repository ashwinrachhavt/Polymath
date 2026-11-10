import { describe, expect, it } from "vitest";
import { noteContentToMarkdown, unescapeWikiLinks } from "@/domains/knowledge/note-content";
import { extractWikiLinkTitles } from "@/domains/knowledge/notes";

// The rich editor's serializer stores a typed [[Title]] as \[\[Title\]\].
const escaped = String.raw`see \[\[Default to medium effort\]\] and \[\[snake\_case\]\] here`;

describe("wiki links typed in the rich editor", () => {
  it("read back as [[links]] from a stored markdown draft", () => {
    expect(noteContentToMarkdown({ format: "markdown", text: escaped })).toBe(
      "see [[Default to medium effort]] and [[snake_case]] here",
    );
  });

  it("resolve to titles for the link sync", () => {
    expect(extractWikiLinkTitles(escaped)).toEqual(["Default to medium effort", "snake_case"]);
  });

  it("leave other escaped brackets alone", () => {
    expect(unescapeWikiLinks(String.raw`a \[literal\] bracket`)).toBe(String.raw`a \[literal\] bracket`);
  });
});
