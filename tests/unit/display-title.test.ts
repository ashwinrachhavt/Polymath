import { describe, expect, it } from "vitest";
import { displayTitle, markdownToPlainText } from "@/lib/display-text";

/*
 * Regression: ISSUE-001 — raw markdown leaked into conversation titles.
 * Found by /qa on 2026-10-24
 * Report: .gstack/qa-reports/run-20261024T193102Z/qa-report-localhost-2026-10-24.md
 *
 * The home list, history menu, run header and briefing all render the stored
 * objective verbatim; a first message that pasted a note link showed literal
 * `[Note: …](/alfred/notes?note=…)` on every surface.
 */
describe("displayTitle", () => {
  it("reduces a markdown note link to its label", () => {
    const raw = "[Note: Logical Fallacies](/alfred/notes?note=e03a2c4a) Summarize this";
    expect(displayTitle(raw)).toBe("Note: Logical Fallacies Summarize this");
  });

  it("keeps plain text untouched", () => {
    expect(displayTitle("Are you connected to Notion?")).toBe("Are you connected to Notion?");
  });

  it("collapses whitespace", () => {
    expect(displayTitle("  a\n\n  b  ")).toBe("a b");
  });

  it("strips headings, emphasis and code spans", () => {
    expect(displayTitle("# Heading\n**bold** and `code`")).toBe("Heading bold and code");
  });

  it("reduces an image to its alt text", () => {
    expect(displayTitle("![diagram](https://example.com/x.png) explain")).toBe("diagram explain");
  });

  // Regression (adversarial F4): the emphasis strip used to eat intra-word
  // markers, so math and identifiers lost their separators.
  it("keeps multiplication and snake_case intact", () => {
    expect(displayTitle("what is 2 * 3 * 4")).toBe("what is 2 * 3 * 4");
    expect(displayTitle("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("still strips real emphasis around words", () => {
    expect(displayTitle("this is **bold** and _it_")).toBe("this is bold and it");
  });
});

/*
 * Regression: ISSUE-004 — the notes editor sent raw markdown as `plainText`,
 * so list previews showed `# When most projects begin…` with syntax intact.
 * Found by /qa on 2026-10-24
 * Report: .gstack/qa-reports/run-20261024T193102Z/qa-report-localhost-2026-10-24.md
 */
describe("markdownToPlainText", () => {
  it("strips a leading heading marker but keeps the line", () => {
    expect(markdownToPlainText("# When most projects begin\nBody here.")).toBe(
      "When most projects begin\nBody here.",
    );
  });

  it("unwraps links and emphasis inside a line", () => {
    expect(markdownToPlainText("See [the spec](/docs) for **details**.")).toBe("See the spec for details.");
  });

  it("keeps list item text without the bullet marker", () => {
    expect(markdownToPlainText("- first\n- second")).toBe("first\nsecond");
  });
});
