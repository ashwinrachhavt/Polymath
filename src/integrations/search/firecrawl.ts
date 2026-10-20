import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * Firecrawl's hosted Search API: the first verified recurring free allowance
 * among the keyed providers (1,000 credits/month, no card; a search costs 2
 * credits per 10 results — verified 2026-10-19 against
 * https://www.firecrawl.dev/pricing). FIRECRAWL_HOSTED_API_KEY is separate
 * from FIRECRAWL_API_KEY on purpose: the existing key belongs to the local
 * self-hosted scrape/crawl stack, and reusing it here would silently send
 * queries to a hosted metered account.
 *
 * Quota is not enforced in this transport. The caller (the web-search seam)
 * reserves credits from the shared ledger before invoking it, exactly as the
 * self-hosted client's comment puts it: this module does not gate.
 */

const ENDPOINT = "https://api.firecrawl.dev/v1/search";

/** Verified unit cost: 2 credits per 10 results. */
export function firecrawlSearchCost(limit: number): number {
  return Math.max(2, Math.ceil(limit / 10) * 2);
}

type FirecrawlSearchBody = {
  success?: boolean;
  data?: Array<{ url?: string; title?: string; description?: string }>;
  error?: string;
};

export function firecrawlSearchProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): WebSearchProvider {
  const apiKey = env.FIRECRAWL_HOSTED_API_KEY;
  if (!apiKey) {
    throw new WebSearchError("SEARCH_PROVIDER=firecrawl needs FIRECRAWL_HOSTED_API_KEY.", "firecrawl");
  }
  return {
    name: "firecrawl",
    async search(query, limit) {
      const response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Provider text can carry account detail; the caller gets status only.
        throw new WebSearchError(`Firecrawl search returned ${response.status}`, "firecrawl");
      }
      const body = (await response.json().catch(() => null)) as FirecrawlSearchBody | null;
      if (!body?.success || !Array.isArray(body.data)) {
        throw new WebSearchError("Firecrawl search returned no results body", "firecrawl");
      }
      const results: WebSearchResult[] = [];
      for (const hit of body.data) {
        if (typeof hit.title !== "string" || typeof hit.url !== "string") continue;
        results.push({
          title: hit.title,
          url: hit.url,
          snippet: typeof hit.description === "string" ? hit.description : "",
          publishedAt: null,
        });
      }
      return results;
    },
  };
}
