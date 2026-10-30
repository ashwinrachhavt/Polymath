import {
  GenerationUnconfiguredError,
  type GenerationProvider,
} from "./provider";
import { providerFromCatalog } from "./openai-compatible-providers";

/*
 * The status-quo generation route: the workspace's own OpenRouter key. This
 * is a paid route the workspace already funds, not a free allowance — the
 * registry marks it "paid", and the seam never selects it as a rescue when a
 * free route is exhausted; it runs only when configured explicitly or when it
 * is the only key present (the pre-ASH-187 default).
 *
 * Since the catalog (openai-compatible-providers.ts) this is a thin wrapper
 * over the shared OpenAI-wire adapter; the streamUsage flag keeps the
 * include_usage request so metered() still sees token counts. The model
 * override parameter is preserved for pre-ASH-187 callers that pin a model.
 */

export function openRouterProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  modelOverride?: string,
): GenerationProvider {
  const provider = providerFromCatalog("openrouter", env, fetchImpl, modelOverride);
  if (!provider) throw new GenerationUnconfiguredError();
  return provider;
}
