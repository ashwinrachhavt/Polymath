import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * Tavily: search API aimed at agents, free tier 1,000 credits/month at the
 * time of writing. https://docs.tavily.com
 */

const ENDPOINT = "https://api.tavily.com/search";

type TavilyResponse = {
  results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
};

export function tavilyProvider(env: Record<string, string | undefined>): WebSearchProvider {
  const apiKey = env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new WebSearchError("SEARCH_PROVIDER=tavily needs TAVILY_API_KEY.", "tavily");
  }
  return {
    name: "tavily",
    async search(query, limit) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: limit,
          search_depth: "basic",
          include_answer: false,
        }),
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new WebSearchError(`Tavily search returned ${response.status}`, "tavily");
      }
      const body = (await response.json()) as TavilyResponse;
      const results: WebSearchResult[] = [];
      for (const hit of body.results ?? []) {
        if (typeof hit.title !== "string" || typeof hit.url !== "string") continue;
        results.push({
          title: hit.title,
          url: hit.url,
          snippet: typeof hit.content === "string" ? hit.content : "",
          publishedAt: typeof hit.published_date === "string" ? hit.published_date : null,
        });
      }
      return results;
    },
  };
}
