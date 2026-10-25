/*
 * The one shape generation adapters implement (ASH-187). Until now every
 * model call in the repo hand-rolled its own OpenRouter request; this seam is
 * the single path, so the free-first route (a verified free Gemini tier) and
 * the existing paid route (the workspace's OpenRouter key) differ only in
 * configuration, and quota admission wraps the seam once rather than per call
 * site.
 *
 * Selection: GENERATION_PROVIDER=gemini|openrouter wins outright. Without it
 * the workspace's status quo holds — OpenRouter when its key is set — and the
 * free Gemini route is taken only when its key is the one configured. There
 * is no automatic rescue: an exhausted or failing provider is an error the
 * caller surfaces, never a silent hop to a metered route.
 */

export type GenerateInput = {
  system?: string;
  prompt: string;
  /** Ask the provider for a JSON response body. */
  json?: boolean;
  temperature?: number;
};

export interface GenerationProvider {
  /** Recorded as the proposer, e.g. "gemini:gemini-3.5-flash-lite". */
  readonly name: string;
  /** The registry id used for quota admission, e.g. "gemini". */
  readonly registryId: string;
  generate(input: GenerateInput): Promise<{ text: string }>;
}

export class GenerationUnconfiguredError extends Error {
  constructor() {
    super("No generation provider configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
    this.name = "GenerationUnconfiguredError";
  }
}

export class GenerationRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`Generation request failed (${provider}, HTTP ${status})`);
    this.name = "GenerationRequestError";
  }
}

/** One call never hangs a run. */
export const GENERATION_TIMEOUT_MS = 30_000;

import { fixtureProvider } from "./fixture";
import { geminiProvider } from "./gemini";
import { openRouterProvider } from "./openrouter";

export function generationProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): GenerationProvider {
  const choice = env.GENERATION_PROVIDER?.toLowerCase();
  switch (choice) {
    // E2E journeys only: deterministic and free, explicit opt-in, never a
    // key-detected default. And it fails closed: a production process that
    // somehow carries GENERATION_PROVIDER=fixture gets the same unconfigured
    // error as a keyless run (which callers skip), never fixture content.
    case "fixture":
      if (env.NODE_ENV === "production") throw new GenerationUnconfiguredError();
      return fixtureProvider();
    case "gemini":
      return geminiProvider(env, fetchImpl);
    case "openrouter":
      return openRouterProvider(env, fetchImpl);
    case undefined:
    case "":
      // Status quo first: the workspace's existing paid key keeps its behavior.
      if (env.OPENROUTER_API_KEY) return openRouterProvider(env, fetchImpl);
      if (env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY) return geminiProvider(env, fetchImpl);
      throw new GenerationUnconfiguredError();
    default:
      throw new GenerationUnconfiguredError();
  }
}
