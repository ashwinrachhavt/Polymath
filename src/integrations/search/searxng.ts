import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * The local provider: a SearXNG instance on the machine (compose service
 * `searxng`, `make search-up`). No key and no account; the query never passes
 * through a third party's search API, only through the engines SearXNG fans
 * out to. SEARXNG_URL is required — there is no silent fallback to a public
 * instance, because an unconfigured local provider should fail loudly rather
 * than quietly phone somewhere else.
 *
 * JSON output is requested explicitly (`format=json`), which the instance's
 * settings.yml enables. Only results with a real http(s) URL and a title are
 * kept, same rule as every other adapter.
 */

type SearxngResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string | null;
  }>;
};

export function searxngProvider(env: Record<string, string | undefined>): WebSearchProvider {
  const base = env.SEARXNG_URL?.trim();
  if (!base) {
    throw new WebSearchError("SEARCH_PROVIDER=searxng needs SEARXNG_URL (e.g. http://127.0.0.1:8080).", "searxng");
  }
  const endpoint = `${base.replace(/\/+$/, "")}/search`;

  return {
    name: "searxng",
    async search(query, limit) {
      const url = `${endpoint}?q=${encodeURIComponent(query)}&format=json&safesearch=0&language=en`;
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
        });
      } catch {
        throw new WebSearchError("SearXNG is unreachable", "searxng");
      }
      if (!response.ok) {
        throw new WebSearchError(`SearXNG returned ${response.status}`, "searxng");
      }
      const body = (await response.json().catch(() => null)) as SearxngResponse | null;
      return parseSearxngResults(body, limit);
    },
  };
}

/** Exported for the fixture test: pure response -> results, no network. */
export function parseSearxngResults(body: SearxngResponse | null, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const row of body?.results ?? []) {
    if (results.length >= limit) break;
    const title = row.title?.trim();
    const url = row.url?.trim();
    if (!title || !url) continue;
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    results.push({
      title,
      url,
      snippet: (row.content ?? "").replace(/\s+/g, " ").trim(),
      publishedAt: row.publishedDate ?? null,
    });
  }
  return results;
}
