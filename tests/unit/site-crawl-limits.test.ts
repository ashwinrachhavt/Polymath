import { describe, expect, it } from "vitest";
import { crawlPageLimit, isAssetUrl, pagesToFile, pageTitle } from "@/domains/knowledge/site-crawl";

/*
 * Value: protects=the bounds on what a site crawl reads and files;
 * fails_when=the page limit escapes 20-30 or ignores its setting, an asset or
 * binary address is treated as a page, or the filter files an off-site page,
 * an error page, an empty page or one address twice; seam=the pure limit and
 * filter functions; no_claim=the provider's own crawling (integration suite).
 */

const page = (url: string, markdown = "Some text.", statusCode: number | null = 200) => ({
  url,
  markdown,
  title: null,
  statusCode,
});

describe("crawl page limit", () => {
  it("reads 25 pages unless told otherwise", () => {
    expect(crawlPageLimit({})).toBe(25);
    expect(crawlPageLimit({ CRAWL_MAX_PAGES: "" })).toBe(25);
    expect(crawlPageLimit({ CRAWL_MAX_PAGES: "lots" })).toBe(25);
    expect(crawlPageLimit({ CRAWL_MAX_PAGES: "22.5" })).toBe(25);
  });

  it("takes a setting between 20 and 30 and holds anything else to that range", () => {
    expect(crawlPageLimit({ CRAWL_MAX_PAGES: "28" })).toBe(28);
    expect(crawlPageLimit({ CRAWL_MAX_PAGES: "5" })).toBe(20);
    expect(crawlPageLimit({ CRAWL_MAX_PAGES: "500" })).toBe(30);
  });
});

describe("which crawled pages are filed", () => {
  const start = new URL("https://docs.example/guide");

  it("treats images, scripts, fonts, archives and media as assets, and documents as pages", () => {
    for (const asset of ["/logo.PNG", "/app.js", "/font.woff2", "/release.tar", "/talk.mp4", "/a/b.svg"]) {
      expect(isAssetUrl(new URL(`https://docs.example${asset}`))).toBe(true);
    }
    for (const doc of ["/", "/guide", "/guide.md", "/llms.txt", "/paper.pdf", "/index.html"]) {
      expect(isAssetUrl(new URL(`https://docs.example${doc}`))).toBe(false);
    }
  });

  it("keeps readable pages of the starting site in arrival order, each address once", () => {
    const kept = pagesToFile(
      start,
      [
        page("https://docs.example/guide"),
        page("https://docs.example/guide/#install"),
        page("https://www.docs.example/api?utm_source=x"),
        page("https://elsewhere.example/"),
        page("https://docs.example/img.png"),
        page("https://docs.example/gone", "Not found", 404),
        page("https://docs.example/blank", "  \n "),
        page("http://127.0.0.1/admin"),
        page("not a url"),
      ],
      new Set(),
    );
    expect(kept.map((entry) => entry.key)).toEqual(["https://docs.example/guide", "https://www.docs.example/api"]);
  });

  it("skips addresses filed on an earlier pass", () => {
    const kept = pagesToFile(
      start,
      [page("https://docs.example/guide"), page("https://docs.example/next")],
      new Set(["https://docs.example/guide"]),
    );
    expect(kept.map((entry) => entry.key)).toEqual(["https://docs.example/next"]);
  });
});

describe("crawled page names", () => {
  const url = new URL("https://docs.example/docs/updates.md");
  it("prefers the page's title, then its first heading, then its path", () => {
    expect(pageTitle({ title: "Updates - Docs", markdown: "# Ignored" }, url)).toBe("Updates - Docs");
    expect(pageTitle({ title: null, markdown: "Intro line\n\n## What changed ##\nText" }, url)).toBe("What changed");
    expect(pageTitle({ title: "  ", markdown: "No headings here." }, url)).toBe("docs.example/docs/updates.md");
    expect(pageTitle({ title: null, markdown: "" }, new URL("https://docs.example/"))).toBe("docs.example");
  });
});
