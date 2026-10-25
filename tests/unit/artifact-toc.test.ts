import { describe, expect, it } from "vitest";
import { extractToc } from "@/domains/knowledge/artifact-toc";

describe("extractToc", () => {
  it("collects headings in order with levels", () => {
    const md = "# Title\n\nintro\n\n## First\n\ntext\n\n### Deep\n\n## Second\n";
    expect(extractToc(md)).toEqual([
      { id: "title", text: "Title", level: 1 },
      { id: "first", text: "First", level: 2 },
      { id: "deep", text: "Deep", level: 3 },
      { id: "second", text: "Second", level: 2 },
    ]);
  });

  it("disambiguates duplicate headings", () => {
    const md = "## Plan\n\n## Plan\n";
    expect(extractToc(md).map((e) => e.id)).toEqual(["plan", "plan-2"]);
  });

  it("ignores headings inside fenced code", () => {
    const md = "## Real\n\n```\n# not a heading\n```\n";
    expect(extractToc(md)).toEqual([{ id: "real", text: "Real", level: 2 }]);
  });

  it("returns empty for headingless markdown", () => {
    expect(extractToc("just text\nmore text")).toEqual([]);
  });
});
