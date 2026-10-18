import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

/*
 * Alfred: one first-party agent (agents/product.md — not a persona zoo).
 *
 * Groq through the OpenAI-compatible API. eve's own `openai()` helper pins the
 * newer /responses endpoint, which Groq does not serve, so this uses the
 * provider package's .chat() surface directly (agent-config.md allows a
 * provider-authored LanguageModel). Credentials come from env at runtime:
 * OPENAI_BASE_URL/OPENAI_API_KEY in .env point at Groq locally; production
 * repoints those two vars. gpt-oss-120b is the strongest model the key serves.
 *
 * The top-level modelContextWindowTokens feeds the compaction trigger, which
 * otherwise demands AI Gateway catalog metadata the unlisted model lacks.
 * gpt-oss-120b advertises a 128k context.
 */
const groq = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  baseURL: process.env.OPENAI_BASE_URL ?? "https://api.groq.com/openai/v1",
  // Naming the provider `groq` keeps eve's openai-specific call options
  // (safetyIdentifier, promptCacheKey) out of the request; Groq rejects the
  // latter with "property 'prompt_cache_key' is unsupported".
  name: "groq",
});

export default defineAgent({
  model: groq.chat("openai/gpt-oss-120b"),
  modelContextWindowTokens: 128_000,
});
