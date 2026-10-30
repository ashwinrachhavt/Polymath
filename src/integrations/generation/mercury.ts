import { GenerationUnconfiguredError, type GenerationProvider } from "./provider";
import { providerFromCatalog } from "./openai-compatible-providers";

/*
 * Mercury (Inception Labs): diffusion-token models behind an OpenAI-compatible
 * chat/completions API. New accounts carry a one-time 100M-token grant with no
 * card — the registry entry is freeClass "trial", spend bounded by the quota
 * ledger (MERCURY_TOTAL_TOKENS), never baseline capacity. Selected first in
 * the free-first chain (owner decision 2026-10-29) while the grant lasts;
 * exhausted, it is an error the caller surfaces — never a silent hop.
 */

export function mercuryProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): GenerationProvider {
  const provider = providerFromCatalog("mercury", env, fetchImpl);
  if (!provider) throw new GenerationUnconfiguredError();
  return provider;
}
