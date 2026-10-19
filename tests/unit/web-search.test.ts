import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDuckDuckGoHtml } from "@/integrations/search/duckduckgo";
import { webSearchProvider, WebSearchError } from "@/integrations/search/provider";

/*
 * Provider selection and the DuckDuckGo parser, proven without a network: the
 * fixture is a sanitized slice of DDG's HTML shape (two real results, one
 * ad block with no uddg target). No live calls in CI, ever.
 */

const DDG_FIXTURE = `
<html><body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpricing&amp;rut=abc">Example &amp; Co — Pricing</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpricing">Plans from <b>$10</b>/mo. Free tier included.</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.dev%2Fdocs">Other Dev Docs</a>
    </h2>
    <a class="result__snippet" href="#">Read the documentation.</a>
  </div>
  <div class="result result--ad">
    <a class="result__a" href="//duckduckgo.com/y.js?ad_domain=spam.example">Sponsored</a>
  </div>
</div>
</body></html>`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseDuckDuckGoHtml", () => {
  it("extracts titled results with unwrapped URLs and strips markup", () => {
    const results = parseDuckDuckGoHtml(DDG_FIXTURE, 10);
    expect(results).toEqual([
      {
        title: "Example & Co — Pricing",
        url: "https://example.com/pricing",
        snippet: "Plans from $10/mo. Free tier included.",
        publishedAt: null,
      },
      {
        title: "Other Dev Docs",
        url: "https://other.dev/docs",
        snippet: "Read the documentation.",
        publishedAt: null,
      },
    ]);
  });

  it("skips blocks without a real outbound URL (ads, nav links)", () => {
    const results = parseDuckDuckGoHtml(DDG_FIXTURE, 10);
    expect(results.some((r) => r.url.includes("spam.example"))).toBe(false);
  });

  it("honours the limit", () => {
    expect(parseDuckDuckGoHtml(DDG_FIXTURE, 1)).toHaveLength(1);
  });

  it("returns nothing on a markup change rather than fabricating results", () => {
    expect(parseDuckDuckGoHtml("<html><body><p>new layout</p></body></html>", 10)).toEqual([]);
  });
});

describe("webSearchProvider resolution", () => {
  it("defaults to the zero-key DuckDuckGo provider when no env is set", () => {
    expect(webSearchProvider({}).name).toBe("duckduckgo");
  });

  it("picks the keyed provider whose key exists", () => {
    expect(webSearchProvider({ TAVILY_API_KEY: "tv-test" }).name).toBe("tavily");
    expect(webSearchProvider({ BRAVE_SEARCH_API_KEY: "brv-test" }).name).toBe("brave");
    expect(webSearchProvider({ EXA_API_KEY: "exa-test" }).name).toBe("exa");
  });

  it("honours an explicit SEARCH_PROVIDER", () => {
    expect(webSearchProvider({ SEARCH_PROVIDER: "duckduckgo", TAVILY_API_KEY: "tv-test" }).name).toBe("duckduckgo");
  });

  it("fails loudly when a keyed provider is named without its key", () => {
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "brave" })).toThrow(WebSearchError);
  });

  it("fails loudly on an unknown provider name", () => {
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "altavista" })).toThrow(WebSearchError);
  });
});
