import { describe, expect, it } from "vitest";
import { extractPageText, htmlTitle, htmlToText, isHtmlDocument } from "@/domains/knowledge/html-to-text";

describe("htmlToText", () => {
  it("keeps block text and drops script, style, and head contents", () => {
    const html = `<!doctype html><html><head><title>T</title><style>body{color:red}</style></head>
      <body><h1>Rent agreement</h1><p>First paragraph.</p><p>Second &amp; final.</p>
      <script>fetch('/track')</script><noscript>enable js</noscript></body></html>`;
    expect(htmlToText(html)).toBe("# Rent agreement\n\nFirst paragraph.\n\nSecond & final.");
  });

  it("marks headings with their level and list items with dashes", () => {
    expect(htmlToText("<h2>Terms</h2><ul><li>One</li><li>Two</li></ul>")).toBe("## Terms\n\n- One\n- Two");
  });

  it("decodes numeric and named entities and collapses whitespace", () => {
    expect(htmlToText("<p>A&nbsp;B &#8212; C &#x27;D&#x27;</p>")).toBe("A B — C 'D'");
  });

  it("drops nested drop elements and strips leftover tags", () => {
    const html = "<template><div><script>bad()</script></div></template><p>kept <b>bold</b> text</p>";
    expect(htmlToText(html)).toBe("kept bold text");
  });

  it("returns an empty string for a page with no reading text", () => {
    expect(htmlToText("<html><body><script>only()</script></body></html>")).toBe("");
  });
});

describe("htmlTitle", () => {
  it("reads and decodes the title", () => {
    expect(htmlTitle("<title>Tom &amp; Jerry  —  Cartoons</title>")).toBe("Tom & Jerry — Cartoons");
  });
  it("is null without a title", () => {
    expect(htmlTitle("<html><body>hi</body></html>")).toBeNull();
  });
});

describe("isHtmlDocument", () => {
  const page = new TextEncoder().encode("<!DOCTYPE html><html><body>hi</body></html>");
  it("trusts an html content type", () => {
    expect(isHtmlDocument("text/html; charset=utf-8", page)).toBe(true);
    expect(isHtmlDocument("application/xhtml+xml", page)).toBe(true);
  });
  it("sniffs html served with a generic or missing type", () => {
    expect(isHtmlDocument("application/octet-stream", page)).toBe(true);
    expect(isHtmlDocument(null, new TextEncoder().encode("  <html><body>x</body>"))).toBe(true);
  });
  it("refuses non-html types and non-html bodies", () => {
    expect(isHtmlDocument("application/pdf", new TextEncoder().encode("%PDF-1.4"))).toBe(false);
    expect(isHtmlDocument(null, new TextEncoder().encode("plain words, no tags"))).toBe(false);
  });
});

describe("extractPageText", () => {
  it("returns both parts", () => {
    expect(extractPageText("<title>Doc</title><body><p>Body</p>")).toEqual({ title: "Doc", text: "Body" });
  });
});
