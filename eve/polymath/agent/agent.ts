import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { geminiFetch } from "./lib/gemini-openai";
import { providerErrorGuardFetch } from "./lib/provider-error-guard";
import { withMaxOutputTokens } from "../../../src/domains/agents/model-output-limit";
// Relative, not "@/...": eve bundles from its own package root (see hooks/bridge.ts).
import { resolveSessionRoute } from "../../../src/domains/billing/resolver";

/*
 * Polymath: one first-party agent (agents/product.md — not a persona zoo).
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
/*
 * The model for one step.
 *
 * The run freezes its model at start (`agent_runs.model`, copied from the
 * profile's `model_policy.primary`), so a conversation cannot change model
 * mid-thread and the spend row and the executing model are the same value.
 * Before this, the run recorded one model for pricing and the agent always ran
 * Gemini — two numbers that disagreed and only one of them was billed.
 *
 * `runModel` is passed by the session context (`axiom-run-model`); when it is
 * absent the env var decides, which is what evals and the local TUI use. The
 * catalog (src/domains/agents/models.ts) owns the ids, base URLs and key env
 * names; `eve eval chat-grounding` drives a real tool call and follow-up turn,
 * so run it before changing the default entry.
 */
async function polymathModel(workspaceId: string | null, runModel?: string | null) {
  // The billing resolver owns key choice: the workspace's own key, else the house key under the weekly
  // allowance. It throws, never substitutes silently, when the frozen model has left the catalog, the
  // key is missing, or the allowance is used up; the message names the restart case for a missing house key.
  const route = await resolveSessionRoute(workspaceId, runModel ?? process.env.GEMINI_AGENT_MODEL);
  const entry = route.option;
  const apiKey = route.apiKey;

  const guarded = providerErrorGuardFetch();

  const provider = createOpenAI({
    apiKey,
    baseURL: entry.baseUrl,
    name: entry.provider,
    fetch: entry.provider === "gemini" ? geminiFetch(guarded) : guarded,
  });
  const model = provider.chat(entry.id);
  // OpenRouter's credit check reserves the full max_tokens amount. Its catalog
  // maximum (16k) exceeded the remaining credit in a real chat and caused a
  // silent-looking turn failure; cap the request while retaining streaming.
  return entry.provider === "openrouter" ? withMaxOutputTokens(model, 12_000) : model;
}

export default defineAgent({
  /*
   * No optional default tools. Eve otherwise advertises bash, read_file,
   * write_file, glob, grep, and friends to every agent; for a chief-of-staff
   * agent that is both a reachable shell on the host and thousands of tokens of
   * tool schema on every step (which showed up as a bloated request and a
   * free-tier rate limit during the first app-level run). Polymath reaches the
   * world through the authored tools in agent/tools/, which are policy-gated;
   * nothing here should have a shell.
   */
  defaultTools: false,
  // step.started is the only scope that may return a live LanguageModel
  // (session/turn selections must be serializable gateway id strings).
  model: defineDynamic({
    events: {
      // The run's frozen model rides in the signed bridge token, which the
      // channel publishes as a session attribute; eve has no per-run config
      // channel before the first step. The env var is the fallback for evals
      // and the TUI, which have no run row.
      "step.started": async (_event, ctx) => {
        const attributes = ctx.session.auth.current?.attributes;
        const fromSession = attributes?.model;
        const runModel = typeof fromSession === "string" ? fromSession : process.env.AXIOM_RUN_MODEL;
        const workspaceId = typeof attributes?.workspaceId === "string" ? attributes.workspaceId : null;
        return {
          model: await polymathModel(workspaceId, runModel),
          modelContextWindowTokens: 128_000,
        };
      },
    },
  }),
});
