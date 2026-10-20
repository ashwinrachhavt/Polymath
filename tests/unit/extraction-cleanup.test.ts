import { describe, expect, it } from "vitest";
import { normalizeExtractedText, normalizePageText } from "@/integrations/extraction/cleanup";

describe("normalizePageText", () => {
  it("strips control characters except newline and tab", () => {
    expect(normalizePageText("a\u0000b\u0007c\u001fd\u007fe")).toBe("abcde");
    expect(normalizePageText("line\nline\ttab")).toBe("line\nline\ttab");
  });

  it("trims trailing whitespace per line", () => {
    expect(normalizePageText("kept \nalso kept\t\ntrailing   ")).toBe(
      "kept\nalso kept\ntrailing",
    );
  });
});

describe("normalizeExtractedText", () => {
  it("collapses three or more blank lines to one", () => {
    expect(normalizeExtractedText("a\n\n\n\n\nb", "plain")).toBe("a\n\nb");
    expect(normalizeExtractedText("a\n\nb", "plain")).toBe("a\n\nb");
  });

  it("drops leading and trailing markdown page-marker lines", () => {
    expect(normalizeExtractedText("- 3 -\n\nbody text\n\n- 4 -", "markdown")).toBe("body text");
    expect(normalizeExtractedText("body with - 3 - inline", "markdown")).toBe(
      "body with - 3 - inline",
    );
    // Plain format keeps markers: only markdown drops them.
    expect(normalizeExtractedText("- 3 -\nbody", "plain")).toBe("- 3 -\nbody");
  });

  it("passes through clean text unchanged", () => {
    const clean = "# Heading\n\nParagraph one.\n\nParagraph two.\n";
    expect(normalizeExtractedText(clean, "markdown")).toBe("# Heading\n\nParagraph one.\n\nParagraph two.");
  });

  it("returns empty for control-character-only input", () => {
    expect(normalizeExtractedText("\u0000\u0007\u001f", "plain")).toBe("");
  });
});
