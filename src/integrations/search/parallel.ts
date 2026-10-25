import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * Parallel Search API: LLM-optimized web search with excerpts. Up to 5,000
 * requests/month free, but the account needs a payment card and overage bills,
 * so the registry entry stays disabled until that consent is explicit.
 * https://docs.parallel.ai
 */

const ENDPOINT = "https://api.parallel.ai/v1/search";

type ParallelResponse = {
  results?: Array<{
    url?: string;
    title?: string;
    publish_date?: string | null;
    excerpts?: string[];
  }>;
};

export function parallelProvider(env: Record<string, string | undefined>): WebSearchProvider {
  const apiKey = env.PARALLEL_API_KEY;
  if (!apiKey) {
    throw new WebSearchError("SEARCH_PROVIDER=parallel needs PARALLEL_API_KEY.", "parallel");
  }
  return {
    name: "parallel",
    async search(query, limit) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          objective: query,
          search_queries: [query],
          mode: "fast",
          max_results: limit,
        }),
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new WebSearchError(`Parallel search returned ${response.status}`, "parallel");
      }
      const body = (await response.json()) as ParallelResponse;
      const results: WebSearchResult[] = [];
      for (const hit of body.results ?? []) {
        if (typeof hit.url !== "string") continue;
        results.push({
          title: typeof hit.title === "string" && hit.title ? hit.title : hit.url,
          url: hit.url,
          snippet: (hit.excerpts ?? []).filter((e): e is string => typeof e === "string").join("\n"),
          publishedAt: typeof hit.publish_date === "string" ? hit.publish_date : null,
        });
      }
      return results;
    },
  };
}
