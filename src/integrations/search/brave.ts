import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * Brave Search API: a real web index with a free tier (2,000 queries/month at
 * the time of writing), so it is the first keyed provider the resolver picks.
 * https://api.search.brave.com/app/documentation/web-search/get-started
 */

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type BraveWebResults = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      page_age?: string;
    }>;
  };
};

export function braveProvider(env: Record<string, string | undefined>): WebSearchProvider {
  const apiKey = env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new WebSearchError("SEARCH_PROVIDER=brave needs BRAVE_SEARCH_API_KEY.", "brave");
  }
  return {
    name: "brave",
    async search(query, limit) {
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}`;
      const response = await fetch(url, {
        headers: { accept: "application/json", "x-subscription-token": apiKey },
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Provider text can carry account detail; the caller gets status only.
        throw new WebSearchError(`Brave search returned ${response.status}`, "brave");
      }
      const body = (await response.json()) as BraveWebResults;
      const results: WebSearchResult[] = [];
      for (const hit of body.web?.results ?? []) {
        if (typeof hit.title !== "string" || typeof hit.url !== "string") continue;
        results.push({
          title: hit.title,
          url: hit.url,
          snippet: typeof hit.description === "string" ? hit.description : "",
          publishedAt: typeof hit.page_age === "string" ? hit.page_age : null,
        });
      }
      return results;
    },
  };
}
