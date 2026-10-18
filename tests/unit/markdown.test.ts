import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";

describe("transcript markdown", () => {
  it("renders bold and keeps the markers out", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: "Alfred: **Ashwin** is an engineer" }));
    expect(html).toContain("<strong>Ashwin</strong>");
    expect(html).not.toContain("**");
  });

  it("renders a pipe table as a table", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: "| A | B |\n| --- | --- |\n| 1 | 2 |" }));
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain(">1</td>");
  });

  it("renders bullet lists", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: "- one\n- two" }));
    expect(html).toContain("<ul");
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("never injects raw HTML", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: '<img src=x onerror="alert(1)">' }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
