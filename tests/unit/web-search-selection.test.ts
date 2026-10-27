import { describe, expect, it } from "vitest";
import { webSearchChain, webSearchProvider } from "@/integrations/search/provider";

/*
 * Selection is a spend decision, so it is asserted rather than assumed.
 *
 * The failure this exists to prevent: an owner running SearXNG locally, with
 * live Tavily and Exa keys already paid for, had no search at all the moment
 * that container stopped — because selection returned exactly one adapter and
 * nothing consulted the keys it already held.
 */

describe("web search selection", () => {
  it("yields a single provider when SEARCH_PROVIDER names one", () => {
    // An explicit choice is not second-guessed, however many keys exist.
    const chain = webSearchChain({ SEARCH_PROVIDER: "searxng", SEARXNG_URL: "http://x", TAVILY_API_KEY: "t" });
    expect(chain.map((p) => p.name)).toEqual(["searxng"]);
  });

  it("still picks one provider from webSearchProvider", () => {
    expect(webSearchProvider({ SEARXNG_URL: "http://x", TAVILY_API_KEY: "t" }).name).toBe("searxng");
  });

  it("falls back past a local SearXNG to the keyed providers", () => {
    const chain = webSearchChain({ SEARXNG_URL: "http://x", TAVILY_API_KEY: "t", EXA_API_KEY: "e" });
    expect(chain[0].name).toBe("searxng");
    expect(chain.map((p) => p.name)).toContain("tavily");
    expect(chain.map((p) => p.name)).toContain("exa");
  });

  it("never adds card-backed Parallel to the chain automatically", () => {
    // The registry makes Parallel opt-in: reaching it takes SEARCH_PROVIDER.
    const chain = webSearchChain({ PARALLEL_API_KEY: "p", TAVILY_API_KEY: "t" });
    expect(chain.map((p) => p.name)).not.toContain("parallel");
    expect(webSearchChain({ SEARCH_PROVIDER: "parallel", PARALLEL_API_KEY: "p" }).map((p) => p.name)).toEqual(["parallel"]);
  });

  it("always ends somewhere that answers with no keys at all", () => {
    const chain = webSearchChain({ SEARXNG_URL: "http://x" });
    expect(chain.map((p) => p.name)).toEqual(["searxng", "duckduckgo"]);
  });

  it("lists each provider once", () => {
    const chain = webSearchChain({ SEARXNG_URL: "http://x", TAVILY_API_KEY: "t", EXA_API_KEY: "e", BRAVE_SEARCH_API_KEY: "b" });
    const names = chain.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
