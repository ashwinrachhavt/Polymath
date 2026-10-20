import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { geminiFetch } from "./lib/gemini-openai";

/*
 * Alfred: one first-party agent (agents/product.md — not a persona zoo).
 *
 * Gemini through its OpenAI-compatible surface
 * (https://generativelanguage.googleapis.com/v1beta/openai/). The repo's
 * free-first provider registry already treats Gemini as the generation route
 * (src/integrations/providers/registry.ts, src/integrations/generation/gemini.ts),
 * so the agent and the rest of the product share one provider and one quota
 * story instead of the agent holding a separate credential.
 *
 * The OpenAI-compatible endpoint is used rather than a Gemini-native client
 * because `@ai-sdk/openai` is already a dependency and the shape is identical to
 * the Groq setup this replaces: `createOpenAI({ baseURL }).chat(model)`. It also
 * keeps eve's openai-specific call options (`safetyIdentifier`,
 * `promptCacheKey`) out of the request — Gemini rejects `prompt_cache_key`.
 *
 * Credentials resolve INSIDE the dynamic model handler — at call time, not at
 * module load. The deployed Eve service bundles this module, and on Vercel the
 * bundle's module-scope env reads did not see the deployment's env (runs failed
 * with an invalid key while the vars were set). Resolving per step guarantees
 * the runtime env is what the provider sees.
 *
 * `modelContextWindowTokens` rides in the resolver selection (a dynamic model
 * cannot declare it at the top level); it feeds the compaction trigger, which
 * otherwise demands AI Gateway catalog metadata an unlisted model lacks.
 */
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
/**
 * The latest model, on the free tier. `geminiFetch` makes it work with tools by
 * repairing both directions of the OpenAI-compatible exchange: it adds the
 * `index` Gemini omits from streaming tool calls, and it round-trips the 3.x
 * `thought_signature` the API requires back on the next request. Without the
 * second half, a tool-using turn fails on the follow-up with "Function call is
 * missing a thought_signature in functionCall parts" — which is exactly what the
 * first app-level run hit.
 *
 * `eve eval chat-grounding` is the check that this still works: it drives a real
 * tool call and a follow-up turn. Run it before changing this value.
 */
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";

function alfredModel() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
  // `fetch` repairs Gemini's streaming tool-call deltas, which omit the `index`
  // the OpenAI schema requires; see lib/gemini-openai.ts.
  const provider = createOpenAI({ apiKey, baseURL: GEMINI_OPENAI_BASE, name: "gemini", fetch: geminiFetch() });
  return provider.chat(process.env.GEMINI_AGENT_MODEL || GEMINI_DEFAULT_MODEL);
}

export default defineAgent({
  /*
   * No optional default tools. Eve otherwise advertises bash, read_file,
   * write_file, glob, grep, and friends to every agent; for a chief-of-staff
   * agent that is both a reachable shell on the host and thousands of tokens of
   * tool schema on every step (which showed up as a bloated request and a
   * free-tier rate limit during the first app-level run). Alfred reaches the
   * world through the authored tools in agent/tools/, which are policy-gated;
   * nothing here should have a shell.
   */
  defaultTools: false,
  // step.started is the only scope that may return a live LanguageModel
  // (session/turn selections must be serializable gateway id strings).
  model: defineDynamic({
    events: {
      "step.started": () => ({ model: alfredModel(), modelContextWindowTokens: 128_000 }),
    },
  }),
});
