import { openAICompatibleProvider } from "./openai-compatible";

/*
 * The OpenAI-compatible provider catalog: adding a chat/completions-shaped
 * provider is an entry here, not a new adapter. Each entry names the env var
 * that carries its key so selection code and capability-config stay in sync.
 *
 * Consumers resolve a catalog id through mercuryProvider()/openRouterProvider()
 * or call openAICompatibleProvider() directly with a config built from
 * resolveProviderConfig(id, env).
 */

export type ProviderCatalogEntry = {
  baseUrl: string;
  /** Env vars checked in order for the API key; the first set one wins. */
  apiKeyEnv: readonly string[];
  defaultModel: string;
  /** Env var overriding defaultModel when set. */
  modelEnv?: string;
  headers?: Record<string, string>;
  streamUsage?: boolean;
};

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = {
  mercury: {
    baseUrl: "https://api.inceptionlabs.ai/v1",
    apiKeyEnv: ["MERCURY_API_KEY", "INCEPTION_API_KEY"],
    defaultModel: "mercury-3",
    modelEnv: "MERCURY_MODEL",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    defaultModel: "openai/gpt-4o-mini",
    modelEnv: "GENERATION_MODEL",
    streamUsage: true,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o-mini",
    modelEnv: "OPENAI_MODEL",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
    modelEnv: "ANTHROPIC_MODEL",
    headers: { "anthropic-version": "2023-06-01" },
  },
};

/**
 * Build a live provider from a catalog id, or null when none of the entry's
 * key env vars are set. The model override parameter (pre-ASH-187 callers,
 * e.g. the zettel extractor pinning a cheap model) wins over every env value.
 */
export function providerFromCatalog(
  id: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  modelOverride?: string,
): ReturnType<typeof openAICompatibleProvider> | null {
  const entry = PROVIDER_CATALOG[id];
  if (!entry) return null;
  const apiKey = entry.apiKeyEnv.map((k) => env[k]).find(Boolean);
  if (!apiKey) return null;
  const model = modelOverride || (entry.modelEnv ? env[entry.modelEnv] : undefined) || entry.defaultModel;
  return openAICompatibleProvider(
    { baseUrl: entry.baseUrl, apiKey, model, registryId: id, headers: entry.headers, streamUsage: entry.streamUsage },
    fetchImpl,
  );
}
