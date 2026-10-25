import type { AuthContext } from "@/domains/identity/resolve";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, QuotaExhaustedError, withQuota, type QuotaStore } from "@/integrations/providers/quota";
import { firecrawlSearchCost } from "@/integrations/search/firecrawl";
import { WebSearchError, webSearchProvider, type WebSearchResponse } from "@/integrations/search/provider";

/*
 * What the agent's `web.search` tool and the /api/v1/search route both call.
 * A read only: it asks the configured provider and returns normalized results.
 * It stores nothing — search output goes into the run's tool_calls row by the
 * event bridge, which is the same audit treatment every tool result gets.
 *
 * Provider errors are collapsed to a fixed message: an adapter's error text
 * can carry account or key detail, and the model (or API client) has no use
 * for it either way.
 *
 * ASH-187: when the resolved provider carries a quota in the registry (the
 * hosted Firecrawl route today), the call reserves its credits from the
 * shared ledger first and stops hard when the free allowance is exhausted.
 * No paid fallback, no recharge — an exhausted route is a clean error, not a
 * silent switch to a metered provider.
 */

export const WEB_SEARCH_CAPABILITY = "web.search";
export const WEB_SEARCH_MAX_RESULTS = 10;

export type AgentWebSearchResult =
  | ({ ok: true } & WebSearchResponse)
  | { ok: false; error: string };

export async function searchWebForAgent(
  // The workspace is part of the signature on purpose: the quota ledger is
  // per-workspace, so a provider with a metered allowance needs to know whose
  // balance the reservation draws on.
  auth: Pick<AuthContext, "workspaceId">,
  input: { query: string; limit?: number },
  quotaStore?: QuotaStore,
): Promise<AgentWebSearchResult> {
  const query = input.query.trim();
  if (!query) return { ok: false, error: "query is empty" };
  const limit = Math.min(Math.max(input.limit ?? 5, 1), WEB_SEARCH_MAX_RESULTS);
  try {
    const provider = webSearchProvider();
    // Fail closed like every other provider route: a registry-disabled entry
    // (parallel's card-backed tier, the gateway's post-promo billing) must not
    // execute because its key happens to be set. The gateway adapters report
    // per-tool names (ai-gateway-tako, ...) over one shared registry entry.
    const entry = providerEntry(provider.name) ?? providerEntry(provider.name.replace(/^(ai-gateway-).+/, "$1search"));
    if (!entry || !entry.enabled) {
      return {
        ok: false,
        error: `web search provider ${provider.name} is registered as disabled; enabling it is a code change in the provider registry, not a setting`,
      };
    }
    const run = () => provider.search(query, limit);
    const results = entry.quota
      ? await withQuota(quotaStore ?? drizzleQuotaStore(), entry, auth.workspaceId, searchCostEstimate(provider.name, limit), run)
      : await run();
    return { ok: true, provider: provider.name, query, results };
  } catch (cause) {
    if (cause instanceof QuotaExhaustedError) {
      return { ok: false, error: `free search allowance exhausted for ${cause.provider}; it renews with the next period` };
    }
    if (cause instanceof WebSearchError) {
      return { ok: false, error: `web search failed (${cause.provider}), try again` };
    }
    return { ok: false, error: "web search failed, try again" };
  }
}

/** What one search call costs the provider's allowance, from the registry entry's verified pricing. */
function searchCostEstimate(providerName: string, limit: number): number {
  if (providerName === "firecrawl") return firecrawlSearchCost(limit);
  return 1; // one request against a request-metered allowance
}
