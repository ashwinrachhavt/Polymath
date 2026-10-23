import { describe, expect, it } from "vitest";
import { linkTargetInsertion, sanitizeLinkText } from "@/components/products/alfred/link-target-insertion";

/*
 * Row 36 follow-up: picker targets with a canonical href (captures, tasks)
 * insert a real Markdown link; note/zettel targets keep the [[wiki link]] so
 * the save path grows a graph edge. Link text is sanitized so a title with
 * Markdown delimiters cannot break the serialized [text](href) or [[title]].
 */

describe("linkTargetInsertion", () => {
  it("inserts a [[wiki link]] for targets without an href", () => {
    expect(linkTargetInsertion({ id: "1", title: "Quarterly plan", kind: "note" })).toBe("[[Quarterly plan]] ");
  });

  it("inserts a link-marked text node for href targets", () => {
    const out = linkTargetInsertion({ id: "c1", title: "Call the accountant", kind: "capture", href: "/command-center/inbox?id=c1" });
    expect(out).toEqual([
      { type: "text", text: "Call the accountant", marks: [{ type: "link", attrs: { href: "/command-center/inbox?id=c1" } }] },
      { type: "text", text: " " },
    ]);
  });

  it("strips Markdown delimiters and collapses whitespace so the serialized link cannot split", () => {
    expect(sanitizeLinkText("a [b] c")).toBe("a b c");
    expect(sanitizeLinkText("x \\n y")).toBe("x n y");
    expect(sanitizeLinkText("line one\nline two")).toBe("line one line two");
    expect(sanitizeLinkText("[[]]")).toBe("Untitled");
    const out = linkTargetInsertion({ id: "t1", title: "Review [draft] spec", kind: "task", href: "/neuralflow/work?task=t1" });
    expect(Array.isArray(out) && out[0].text).toBe("Review draft spec");
    const wiki = linkTargetInsertion({ id: "n1", title: "a ]] b", kind: "note" });
    expect(wiki).toBe("[[a b]] ");
  });
});
