/*
 * The one shape web-search adapters implement. Domain code (and through it the
 * Eve `web_search` tool and the /api/v1/search route) sees only this interface,
 * so swapping providers — or adding a paid one later — touches nothing above
 * this seam.
 *
 * Why these providers: the ask was "free ones". Vercel AI Gateway's built-in
 * search tools (Perplexity/Exa/Tako/Browserbase/Parallel) bill per 1k requests
 * and their free promos expired in Aug/Sep 2026, so the default here is a
 * zero-key DuckDuckGo adapter, with free-tier keyed providers (Brave, Tavily,
 * Exa) selected automatically when their env key is present. ASH-187 adds the
 * hosted Firecrawl route: the one verified recurring free search allowance
 * (1,000 credits/month, no card), quota-gated at the caller through the
 * provider registry and shared ledger — not here in selection.
 */

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  /** ISO date when the provider knows one, else null. */
  publishedAt: string | null;
};

export type WebSearchResponse = {
  /** Which adapter produced these results, e.g. "duckduckgo". */
  provider: string;
  query: string;
  results: WebSearchResult[];
};

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<WebSearchResult[]>;
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

/** One request never hangs a run: providers must finish inside this budget. */
export const WEB_SEARCH_TIMEOUT_MS = 10_000;

import { aiGatewaySearchProvider, AI_GATEWAY_SEARCH_PROVIDERS } from "./ai-gateway";
import { braveProvider } from "./brave";
import { duckDuckGoProvider } from "./duckduckgo";
import { exaProvider } from "./exa";
import { firecrawlSearchProvider } from "./firecrawl";
import { parallelProvider } from "./parallel";
import { searxngProvider } from "./searxng";
import { tavilyProvider } from "./tavily";

/*
 * Pick the adapter from the environment. SEARCH_PROVIDER wins outright;
 * otherwise a configured local SearXNG instance (SEARXNG_URL) is preferred,
 * then the first configured key in cost order of "has a real free tier"
 * (Firecrawl 1k credits/mo, Brave 2k/mo, Tavily 1k/mo, Exa trial credit —
 * card-backed tiers like Parallel stay out of the auto-chain and need an
 * explicit SEARCH_PROVIDER), and with nothing configured
 * the zero-key DuckDuckGo adapter so the tool works with no setup and no spend.
 */
export function webSearchProvider(env: Record<string, string | undefined> = process.env): WebSearchProvider {
  const choice = env.SEARCH_PROVIDER?.toLowerCase();
  const gatewayProvider = AI_GATEWAY_SEARCH_PROVIDERS.find((p) => `ai-gateway-${p}` === choice);
  if (gatewayProvider) return aiGatewaySearchProvider(gatewayProvider, env);
  switch (choice) {
    case "parallel":
      return parallelProvider(env);
    case "firecrawl":
      return firecrawlSearchProvider(env);
    case "searxng":
      return searxngProvider(env);
    case "brave":
      return braveProvider(env);
    case "tavily":
      return tavilyProvider(env);
    case "exa":
      return exaProvider(env);
    case "duckduckgo":
      return duckDuckGoProvider();
    case undefined:
    case "":
      if (env.SEARXNG_URL) return searxngProvider(env);
      if (env.FIRECRAWL_HOSTED_API_KEY) return firecrawlSearchProvider(env);
      if (env.BRAVE_SEARCH_API_KEY) return braveProvider(env);
      if (env.TAVILY_API_KEY) return tavilyProvider(env);
      if (env.EXA_API_KEY) return exaProvider(env);
      return duckDuckGoProvider();
    default:
      throw new WebSearchError(
        `Unknown SEARCH_PROVIDER "${choice}". Expected firecrawl, searxng, brave, tavily, exa, parallel, ai-gateway-<provider>, or duckduckgo.`,
        choice,
      );
  }
}
