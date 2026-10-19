import type { AuthContext } from "@/domains/identity/resolve";
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
 */

export const WEB_SEARCH_CAPABILITY = "web.search";
export const WEB_SEARCH_MAX_RESULTS = 10;

export type AgentWebSearchResult =
  | ({ ok: true } & WebSearchResponse)
  | { ok: false; error: string };

export async function searchWebForAgent(
  // The workspace is part of the signature on purpose: a future provider with
  // per-workspace keys must not have to change the call sites.
  _auth: Pick<AuthContext, "workspaceId">,
  input: { query: string; limit?: number },
): Promise<AgentWebSearchResult> {
  const query = input.query.trim();
  if (!query) return { ok: false, error: "query is empty" };
  const limit = Math.min(Math.max(input.limit ?? 5, 1), WEB_SEARCH_MAX_RESULTS);
  try {
    const provider = webSearchProvider();
    const results = await provider.search(query, limit);
    return { ok: true, provider: provider.name, query, results };
  } catch (cause) {
    if (cause instanceof WebSearchError) {
      return { ok: false, error: `web search failed (${cause.provider}), try again` };
    }
    return { ok: false, error: "web search failed, try again" };
  }
}
