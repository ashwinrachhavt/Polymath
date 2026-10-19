import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * Exa: embeddings-style search aimed at agents, free trial credit at the time
 * of writing. https://docs.exa.ai
 */

const ENDPOINT = "https://api.exa.ai/search";

type ExaResponse = {
  results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>;
};

export function exaProvider(env: Record<string, string | undefined>): WebSearchProvider {
  const apiKey = env.EXA_API_KEY;
  if (!apiKey) {
    throw new WebSearchError("SEARCH_PROVIDER=exa needs EXA_API_KEY.", "exa");
  }
  return {
    name: "exa",
    async search(query, limit) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          query,
          numResults: limit,
          contents: { text: { maxCharacters: 500 } },
        }),
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new WebSearchError(`Exa search returned ${response.status}`, "exa");
      }
      const body = (await response.json()) as ExaResponse;
      const results: WebSearchResult[] = [];
      for (const hit of body.results ?? []) {
        if (typeof hit.url !== "string") continue;
        results.push({
          title: typeof hit.title === "string" && hit.title ? hit.title : hit.url,
          url: hit.url,
          snippet: typeof hit.text === "string" ? hit.text : "",
          publishedAt: typeof hit.publishedDate === "string" ? hit.publishedDate : null,
        });
      }
      return results;
    },
  };
}
