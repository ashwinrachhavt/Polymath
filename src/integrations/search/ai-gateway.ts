import { WebSearchError, type WebSearchProvider } from "./provider";

/*
 * Vercel AI Gateway server-tool search: one AI_GATEWAY_API_KEY reaches Exa,
 * Tako, Parallel, and Perplexity as server tools (`vercel:*_search`) executed
 * inside the chat-completions call. The gateway runs the search itself, so the
 * response is the model's grounded answer plus cited URLs in provider_metadata
 * — not a raw results array. The old free promos for these tools expired in
 * Aug/Sep 2026, so this route bills per 1k requests; the registry entry stays
 * disabled until the spend is opted into.
 * https://vercel.com/docs/ai-gateway/models-and-providers/web-search
 */

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";
/** A cheap gateway model reads the searched context and answers; the search itself is the server tool. */
const GATEWAY_SEARCH_MODEL = "openai/gpt-5.4-mini";
/**
 * A server-tool search wraps a full chat completion around the search, so it
 * gets three search budgets rather than the shared WEB_SEARCH_TIMEOUT_MS.
 * Deliberately its own constant: importing the shared one would make
 * provider.ts <-> ai-gateway.ts a circular module init.
 */
const AI_GATEWAY_TIMEOUT_MS = 30_000;

export const AI_GATEWAY_SEARCH_PROVIDERS = ["exa", "tako", "parallel", "perplexity"] as const;
export type AiGatewaySearchProvider = (typeof AI_GATEWAY_SEARCH_PROVIDERS)[number];

type GatewayResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
};

export function aiGatewaySearchProvider(
  provider: AiGatewaySearchProvider,
  env: Record<string, string | undefined>,
): WebSearchProvider {
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new WebSearchError(`SEARCH_PROVIDER=ai-gateway-${provider} needs AI_GATEWAY_API_KEY.`, `ai-gateway-${provider}`);
  }
  return {
    name: `ai-gateway-${provider}`,
    async search(query, limit = 5) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          // The search runs server-side regardless of which chat model answers;
          // a cheap gateway model keeps the answer legible without adding cost.
          model: GATEWAY_SEARCH_MODEL,
          messages: [{ role: "user", content: query }],
          tools: [{ type: `vercel:${provider}_search`, config: { query, num_results: limit } }],
          tool_choice: "required",
        }),
        signal: AbortSignal.timeout(AI_GATEWAY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new WebSearchError(`AI Gateway ${provider} search returned ${response.status}`, `ai-gateway-${provider}`);
      }
      const body = (await response.json()) as GatewayResponse;
      const message = body.choices?.[0]?.message;
      const text =
        typeof message?.content === "string"
          ? message.content
          : (message?.content ?? []).map((part) => part.text ?? "").join("");
      // One synthesized answer, not a URL list — surface it as a single result
      // so the normalized shape still holds.
      return text ? [{ title: query, url: "https://ai-gateway.vercel.sh", snippet: text, publishedAt: null }] : [];
    },
  };
}
