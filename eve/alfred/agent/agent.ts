import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

/*
 * Alfred: one first-party agent (agents/product.md — not a persona zoo).
 *
 * Groq through the OpenAI-compatible API. eve's own `openai()` helper pins the
 * newer /responses endpoint, which Groq does not serve, so this uses the
 * provider package's .chat() surface directly (agent-config.md allows a
 * provider-authored LanguageModel).
 *
 * Credentials resolve INSIDE the dynamic model handler — at call time, not at
 * module load. The deployed Eve service bundles this module, and on Vercel
 * the bundle's module-scope env reads did not see the deployment's env (runs
 * failed with Groq's "Invalid API Key" while OPENAI_BASE_URL/OPENAI_API_KEY
 * were set: the module-scope fallback baseURL fired). Resolving per step
 * guarantees the runtime env is what the provider sees. OPENROUTER_API_KEY is
 * accepted as a fallback so previews can set one unscoped var instead of
 * per-branch OPENAI_* pairs; OPENAI_* wins when both are present.
 *
 * Naming the provider `groq` keeps eve's openai-specific call options
 * (safetyIdentifier, promptCacheKey) out of the request; Groq rejects the
 * latter with "property 'prompt_cache_key' is unsupported".
 *
 * modelContextWindowTokens rides in the resolver selection (a dynamic model
 * cannot declare it at the top level); it feeds the compaction trigger, which
 * otherwise demands AI Gateway catalog metadata the unlisted model lacks.
 * gpt-oss-120b advertises a 128k context.
 */
function alfredModel() {
  // An empty-string OPENAI_API_KEY (set-but-blank in a deployment env) must
  // not shadow a real OpenRouter key: ?? only skips null/undefined, so fall
  // through blank keys explicitly.
  const apiKey =
    [process.env.OPENAI_API_KEY, process.env.OPENROUTER_API_KEY].find((key) => key && key.length > 0) ?? "";
  // Without an explicit OPENAI_BASE_URL, route by the key's shape: an
  // OpenRouter key (sk-or-…) against the Groq default is exactly the deployed
  // failure this fixes, so infer OpenRouter for it instead of failing there.
  const baseURL =
    process.env.OPENAI_BASE_URL ??
    (apiKey.startsWith("sk-or-") ? "https://openrouter.ai/api/v1" : "https://api.groq.com/openai/v1");
  const provider = createOpenAI({ apiKey, baseURL, name: "groq" });
  return provider.chat("openai/gpt-oss-120b");
}

export default defineAgent({
  // step.started is the only scope that may return a live LanguageModel
  // (session/turn selections must be serializable gateway id strings).
  model: defineDynamic({
    events: {
      "step.started": () => ({ model: alfredModel(), modelContextWindowTokens: 128_000 }),
    },
  }),
});
