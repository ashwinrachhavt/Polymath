import { describe, expect, it } from "vitest";
import { parseDiffLines, readNotionDiffPreview } from "@/domains/knowledge/diff-preview";
import { appendPreview } from "@/domains/knowledge/notion-proposals";

describe("notion diff preview", () => {
  it("round-trips what appendPreview writes", () => {
    const diff = appendPreview("one\ntwo\nthree\nfour", "new line\n\nsecond");
    const lines = parseDiffLines(diff);
    expect(lines.filter((line) => line.kind === "context").map((line) => line.text)).toEqual(["two", "three", "four"]);
    expect(lines.filter((line) => line.kind === "gap")).toHaveLength(1);
    expect(lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["new line", "", "second"]);
  });

  it("shows an append to an unreadable page as pure additions", () => {
    const lines = parseDiffLines(appendPreview("", "hello"));
    expect(lines).toEqual([{ kind: "add", text: "hello" }]);
  });

  it("does not mistake an added line that starts with a plus or a dash for context", () => {
    const lines = parseDiffLines(appendPreview("", "- item\n+ plus"));
    expect(lines.map((line) => line.kind)).toEqual(["add", "add"]);
    expect(lines.map((line) => line.text)).toEqual(["- item", "+ plus"]);
  });

  it("treats every line of a create proposal as an addition", () => {
    const preview = readNotionDiffPreview(
      { kind: "diff", contentHash: "abc", diff: "# Title\n+ not a marker", title: "T", url: null },
      "create",
    );
    expect(preview?.lines.every((line) => line.kind === "add")).toBe(true);
    expect(preview?.lines[1].text).toBe("+ not a marker");
  });

  it("returns null for a preview that is not a diff, so the card falls back to the payload", () => {
    expect(readNotionDiffPreview(null, "append")).toBeNull();
    expect(readNotionDiffPreview({ kind: "email" }, "append")).toBeNull();
    expect(readNotionDiffPreview({ kind: "diff", diff: "x" }, "append")).toBeNull();
  });
});
