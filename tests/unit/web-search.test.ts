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
    // Parallel is card-backed, so a bare key never auto-selects it: the
    // registry keeps it disabled until the spend is opted into explicitly.
    expect(webSearchProvider({ PARALLEL_API_KEY: "pl-test" }).name).toBe("duckduckgo");
    expect(webSearchProvider({ SEARCH_PROVIDER: "parallel", PARALLEL_API_KEY: "pl-test" }).name).toBe("parallel");
  });

  it("resolves AI Gateway server-tool search by provider suffix", () => {
    for (const suffix of ["exa", "tako", "parallel", "perplexity"]) {
      expect(webSearchProvider({ SEARCH_PROVIDER: `ai-gateway-${suffix}`, AI_GATEWAY_API_KEY: "gw-test" }).name).toBe(
        `ai-gateway-${suffix}`,
      );
    }
  });

  it("refuses an unknown AI Gateway search suffix", () => {
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "ai-gateway-altavista", AI_GATEWAY_API_KEY: "gw" })).toThrow(
      WebSearchError,
    );
  });

  it("honours an explicit SEARCH_PROVIDER", () => {
    expect(webSearchProvider({ SEARCH_PROVIDER: "duckduckgo", TAVILY_API_KEY: "tv-test" }).name).toBe("duckduckgo");
  });

  it("fails loudly when a keyed provider is named without its key", () => {
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "brave" })).toThrow(WebSearchError);
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "parallel" })).toThrow(WebSearchError);
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "ai-gateway-exa" })).toThrow(WebSearchError);
  });

  it("resolves the auto-chain in its documented cost order", () => {
    const env = {
      BRAVE_SEARCH_API_KEY: "brv",
      TAVILY_API_KEY: "tv",
      EXA_API_KEY: "exa",
    };
    expect(webSearchProvider(env).name).toBe("brave");
    // Firecrawl outranks Brave; a card-backed tier like Parallel never
    // auto-selects — it needs an explicit SEARCH_PROVIDER.
    expect(webSearchProvider({ ...env, FIRECRAWL_HOSTED_API_KEY: "fc" }).name).toBe("firecrawl");
  });

  it("fails loudly on an unknown provider name", () => {
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "altavista" })).toThrow(WebSearchError);
  });
});

describe("searchWebForAgent quota gating", () => {
  it("reserves firecrawl credits from the ledger and stops hard at exhaustion", async () => {
    const { searchWebForAgent } = await import("@/domains/knowledge/web-search");
    const { firecrawlSearchCost } = await import("@/integrations/search/firecrawl");
    let spent = 0;
    const cap = firecrawlSearchCost(5); // one search's worth of credits, then exhaustion
    const store = {
      async reserve(_k: unknown, units: number) {
        if (spent + units > cap) return null;
        spent += units;
        return { bucketId: "b" };
      },
      async settle() {},
      async release() {
        spent = 0;
      },
    };
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] })));
    vi.stubEnv("SEARCH_PROVIDER", "firecrawl");
    vi.stubEnv("FIRECRAWL_HOSTED_API_KEY", "fc-test");
    vi.stubGlobal("fetch", f);
    const auth = { workspaceId: "w1" };
    const first = await searchWebForAgent(auth, { query: "q", limit: 5 }, store);
    expect(first.ok).toBe(true);
    expect(spent).toBe(firecrawlSearchCost(5));
    const second = await searchWebForAgent(auth, { query: "q", limit: 5 }, store);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("free search allowance exhausted");
    expect(f).toHaveBeenCalledTimes(1); // the exhausted call never reached the provider
  });
});
