import { describe, expect, it, vi } from "vitest";
import { firecrawlSearchCost, firecrawlSearchProvider } from "@/integrations/search/firecrawl";
import { webSearchProvider, WebSearchError } from "@/integrations/search/provider";

/*
 * The hosted Firecrawl search adapter: request shape, result mapping and the
 * error collapse, proven with a mocked fetch — no live calls in CI.
 */

const hits = (data: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ success: true, data }), { status }));

describe("firecrawlSearchProvider", () => {
  it("needs FIRECRAWL_HOSTED_API_KEY, never the local stack's key", () => {
    expect(() => firecrawlSearchProvider({})).toThrow(WebSearchError);
    expect(() => firecrawlSearchProvider({ FIRECRAWL_API_KEY: "local-only" })).toThrow(WebSearchError);
  });

  it("posts the query with a bearer token and maps the results", async () => {
    const f = hits([{ url: "https://example.com/a", title: "A", description: "first" }, { url: "https://example.com/b", title: "B" }]);
    const p = firecrawlSearchProvider({ FIRECRAWL_HOSTED_API_KEY: "fc-test" }, f as unknown as typeof fetch);
    const results = await p.search("pricing", 5);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.firecrawl.dev/v1/search");
    expect(JSON.parse(String(init.body))).toEqual({ query: "pricing", limit: 5 });
    expect(String((init.headers as Record<string, string>).authorization)).toBe("Bearer fc-test");
    expect(results).toEqual([
      { title: "A", url: "https://example.com/a", snippet: "first", publishedAt: null },
      { title: "B", url: "https://example.com/b", snippet: "", publishedAt: null },
    ]);
  });

  it("fails closed on HTTP errors without keeping provider text", async () => {
    const f = vi.fn(async () => new Response("account detail", { status: 429 }));
    const p = firecrawlSearchProvider({ FIRECRAWL_HOSTED_API_KEY: "fc-test" }, f as unknown as typeof fetch);
    await expect(p.search("x", 5)).rejects.toThrow("Firecrawl search returned 429");
  });
});

describe("firecrawlSearchCost", () => {
  it("charges the verified 2 credits per 10 results, minimum one unit", () => {
    expect(firecrawlSearchCost(5)).toBe(2);
    expect(firecrawlSearchCost(10)).toBe(2);
    expect(firecrawlSearchCost(11)).toBe(4);
  });
});

describe("webSearchProvider with firecrawl", () => {
  it("selects the hosted firecrawl route explicitly or by key", () => {
    expect(webSearchProvider({ SEARCH_PROVIDER: "firecrawl", FIRECRAWL_HOSTED_API_KEY: "k" }).name).toBe("firecrawl");
    expect(webSearchProvider({ FIRECRAWL_HOSTED_API_KEY: "k" }).name).toBe("firecrawl");
    expect(webSearchProvider({ FIRECRAWL_HOSTED_API_KEY: "k", BRAVE_SEARCH_API_KEY: "b" }).name).toBe("firecrawl");
  });

  it("fails loudly when named without its key", () => {
    expect(() => webSearchProvider({ SEARCH_PROVIDER: "firecrawl" })).toThrow(WebSearchError);
  });
});
