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

/** Token counts when the provider reports them; absent when it does not. */
export type GenerationUsage = { inputTokens?: number; outputTokens?: number };

export type StreamChunk =
  | { type: "thinking" | "token"; content: string }
  /* Terminal usage frame when the provider reports stream token counts
   * (review G): adapters emit it when the upstream carries usage; metered()
   * consumes it for the call record and never forwards it downstream. */
  | { type: "usage"; usage: GenerationUsage };

export interface GenerationProvider {
  /** Recorded as the proposer, e.g. "gemini:gemini-3.5-flash-lite". */
  readonly name: string;
  /** The registry id used for quota admission, e.g. "gemini". */
  readonly registryId: string;
  generate(input: GenerateInput): Promise<{ text: string; usage?: GenerationUsage }>;
  /**
   * Optional streaming surface (zettel creation stream, plan 2026-10-29 §8).
   * When a provider cannot stream, Track B runs token-less — stage outcomes
   * still emit, and the absence of this method is never an error.
   */
  stream?(input: GenerateInput): AsyncGenerator<StreamChunk>;
}

export class GenerationUnconfiguredError extends Error {
  constructor() {
    super("No generation provider configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
    this.name = "GenerationUnconfiguredError";
  }
}

/*
 * Fail-fast configuration errors (plan §15.6/§16.5): raised at provider
 * SELECTION, never mid-stream, naming the exact variable to set and the
 * value it expects. Unknown GENERATION_PROVIDER values keep the base class.
 */
export class GenerationConfigError extends GenerationUnconfiguredError {
  constructor(
    readonly variable: string,
    readonly expected: string,
  ) {
    super();
    this.message = `Generation provider misconfigured: set ${variable} (${expected}).`;
    this.name = "GenerationConfigError";
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

import { cloudflareProvider } from "./cloudflare";
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
    // Opt-in only (plan §8): the free-first default chain above is untouched.
    case "cloudflare":
      return cloudflareProvider(env, fetchImpl);
    case undefined:
    case "":
      // Free-first (ASH-187, owner decision 2026-10-27): the free allowance
      // wins over a key that bills. OpenRouter was checked first here, so every
      // debrief, prep brief and draft billed while the Gemini free tier sat
      // configured and unused. OpenRouter remains the second choice, so a
      // workspace that has only that key still generates.
      if (env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY) return geminiProvider(env, fetchImpl);
      if (env.OPENROUTER_API_KEY) return openRouterProvider(env, fetchImpl);
      throw new GenerationUnconfiguredError();
    default:
      throw new GenerationUnconfiguredError();
  }
}

/*
 * Per-call usage accounting (plan §16.4): adapters stay thin; this wrapper
 * records provider, model, call kind, duration and reported token counts to
 * whatever store the caller owns (the creation stream records to its run
 * row). Quota admission stays per run at the call site, never per connection.
 */
export type GenerationCallRecord = {
  /** Registry id, e.g. "gemini". */
  provider: string;
  /** Adapter name, e.g. "gemini:gemini-3.5-flash-lite". */
  model: string;
  kind: "generate" | "stream";
  inputTokens?: number;
  outputTokens?: number;
  startedAt: string;
  durationMs: number;
};

export function metered(
  provider: GenerationProvider,
  record: (entry: GenerationCallRecord) => void | Promise<void>,
): GenerationProvider {
  const wrapped: GenerationProvider = {
    name: provider.name,
    registryId: provider.registryId,
    async generate(input) {
      const startedAt = new Date();
      const out = await provider.generate(input);
      await record({
        provider: provider.registryId,
        model: provider.name,
        kind: "generate",
        inputTokens: out.usage?.inputTokens,
        outputTokens: out.usage?.outputTokens,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      });
      return out;
    },
  };
  if (provider.stream) {
    const inner = provider.stream.bind(provider);
    wrapped.stream = async function* (input: GenerateInput) {
      const startedAt = new Date();
      // Provider-reported stream usage is captured for the record, never
      // forwarded: the chunk contract downstream stays thinking | token.
      let usage: GenerationUsage | undefined;
      for await (const chunk of inner(input)) {
        if (chunk.type === "usage") { usage = chunk.usage; continue; }
        yield chunk;
      }
      await record({
        provider: provider.registryId,
        model: provider.name,
        kind: "stream",
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      });
    };
  }
  return wrapped;
}
