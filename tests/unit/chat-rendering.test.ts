import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CitedText } from "@/components/chat/cited-text";
import { RecordCards } from "@/components/chat/record-card";
import { inline } from "@/components/markdown-inline";

/*
 * What the thread must actually render (ASH-306 / ASH-274). These are the
 * behaviours the product promises: a citation jumps to its source, a record is
 * a real link you can open, and a model-written link renders as a link instead
 * of literal brackets.
 */

const citation = (documentId: string, title: string, start: number) => ({
  documentId,
  title,
  text: "passage",
  span: { start, end: start + 10, page: null },
});

describe("cited answers", () => {
  it("renders a [[n]] marker as a numbered anchor into the source list", () => {
    const html = renderToStaticMarkup(
      createElement(CitedText, { text: "The lease runs for two years [[1]].", citations: [citation("d1", "Lease", 0)] }),
    );
    expect(html).toContain('href="#citation-0"');
    expect(html).toContain(">1</a>");
    expect(html).not.toContain("[[1]]");
  });

  it("drops a marker that names no source rather than rendering a dead number", () => {
    const html = renderToStaticMarkup(createElement(CitedText, { text: "A claim [[7]].", citations: [citation("d1", "Lease", 0)] }));
    expect(html).not.toContain("#citation-6");
    expect(html).not.toContain("[[7]]");
    expect(html).toContain("A claim");
  });

  it("renders plain text untouched when there are no citations", () => {
    const html = renderToStaticMarkup(createElement(CitedText, { text: "Nothing cited here.", citations: [] }));
    // The answer is a paragraph in the transcript's block markup, not a bare
    // text node; what must not happen is any escaping or markup corruption.
    expect(html).toBe("<p>Nothing cited here.</p>");
  });

  /*
   * Regression: the live surface rendered inline spans only, so a fenced block,
   * a rule, or a heading in a model answer reached the reader as its literal
   * characters. The stored thread parsed them; the live one did not.
   */
  it("renders a fenced code block as code, not literal backticks", () => {
    const html = renderToStaticMarkup(
      createElement(CitedText, { text: "Try this:\n\n```ts\nconst x = 1;\n```\n", citations: [] }),
    );
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("```");
  });

  it("renders a thematic break and a quote as blocks", () => {
    const html = renderToStaticMarkup(
      createElement(CitedText, { text: "Above\n\n---\n\n> quoted line\n", citations: [] }),
    );
    expect(html).toContain("<hr");
    expect(html).toContain("<blockquote");
    expect(html).not.toContain("---");
  });

  it("keeps citations working inside a list item", () => {
    const html = renderToStaticMarkup(
      createElement(CitedText, { text: "- the lease runs two years [[1]]\n- it renews\n", citations: [citation("d1", "Lease", 0)] }),
    );
    expect(html).toContain("<li");
    expect(html).toContain('href="#citation-0"');
    expect(html).not.toContain("[[1]]");
  });
});

describe("record cards", () => {
  it("links a document card to its library route", () => {
    const html = renderToStaticMarkup(createElement(RecordCards, { records: [{ kind: "document", id: "doc-1", title: "Renewal terms" }] }));
    expect(html).toContain('href="/alfred/library/doc-1"');
    expect(html).toContain("Renewal terms");
    expect(html).toContain("Document");
  });

  it("shows a record without a detail route as a card, not a broken link", () => {
    const html = renderToStaticMarkup(createElement(RecordCards, { records: [{ kind: "task", id: "t1", title: "Renew the lease", subtitle: "Due 2026-11-01" }] }));
    expect(html).toContain("Renew the lease");
    expect(html).toContain("Due 2026-11-01");
    // Tasks link to their collection, never to an invented /tasks/<id>.
    expect(html).toContain('href="/work"');
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(createElement(RecordCards, { records: [] }))).toBe("");
  });
});

describe("markdown links", () => {
  it("turns [text](href) into an anchor instead of literal brackets", () => {
    const html = renderToStaticMarkup(createElement("div", null, inline("Open [Q3 planning](/alfred/notes) now")));
    expect(html).toContain('href="/alfred/notes"');
    expect(html).toContain("Q3 planning");
    expect(html).not.toContain("[Q3 planning]");
  });

  it("opens an external link away from the thread", () => {
    const html = renderToStaticMarkup(createElement("div", null, inline("[docs](https://example.com/x)")));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("refuses a javascript: href, keeping only its label", () => {
    const html = renderToStaticMarkup(createElement("div", null, inline("[click](javascript:alert(1))")));
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });
});
