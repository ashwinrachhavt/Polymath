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

  it("renders a bold link as a link, with no markup left over", () => {
    const html = renderToStaticMarkup(
      h(Markdown, { text: "* **[Git](https://example.test/git)** - Tools to read Git repositories\n+ plus item" }),
    );
    expect(html).toMatch(/<strong><a href="https:\/\/example.test\/git"[^>]*>Git<\/a><\/strong>/);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).not.toMatch(/\*\*|\]\(|\[Git/);
  });

  it("renders a fence whose info string carries attributes as code", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: "```bash theme={null}\nnpx -y server\n```\nAfter." }));
    expect(html).toContain("<code");
    expect(html).toContain("npx -y server");
    expect(html).not.toContain("```");
    expect(html).toContain("<p>After.</p>");
  });

  it("renders a level-five heading as a heading", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: "##### Small print" }));
    expect(html).toContain("<h4>Small print</h4>");
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

describe("citations and escapes", () => {
  it("renders citation marks as chips and unescapes pipes", () => {
    const html = renderToStaticMarkup(h(Markdown, { text: "Per 【Document: Lease】 the total is \\| 5." }));
    expect(html).toContain("Document: Lease");
    expect(html).not.toContain("【");
    expect(html).toContain("| 5");
    expect(html).not.toContain("\\|");
  });
});
