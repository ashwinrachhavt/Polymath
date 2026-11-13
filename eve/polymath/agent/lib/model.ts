import { createOpenAI } from "@ai-sdk/openai";
import { withMaxOutputTokens } from "../../../../src/domains/agents/model-output-limit";
import { resolveSessionRoute } from "../../../../src/domains/billing/resolver";
import { geminiFetch } from "./gemini-openai";
import { providerErrorGuardFetch } from "./provider-error-guard";

/*
 * A model as the agent calls it, for one step, through the one model resolver.
 *
 * The billing resolver owns key choice (src/domains/billing/resolver.ts): the
 * workspace's own key, else the house key under the weekly allowance. Every
 * model this agent runs, whether the run's frozen model or the small model a
 * lane picks, goes through it, so a lane cannot spend outside the allowance.
 * It throws, never substitutes silently, when the id has left the catalog, the
 * key is missing, or the allowance is used up.
 *
 * Credentials resolve at call time, not at module load: the deployed Eve
 * service bundles this module, and on Vercel the bundle's module-scope env
 * reads did not see the deployment's env.
 */

/** A provider chat model: an object eve can wrap and call per step. */
type ChatModel = ReturnType<ReturnType<typeof createOpenAI>["chat"]>;

export async function routedModel(workspaceId: string | null, modelId: string | null | undefined): Promise<ChatModel> {
  const { option, apiKey } = await resolveSessionRoute(workspaceId, modelId);
  const guarded = providerErrorGuardFetch();
  const provider = createOpenAI({
    apiKey,
    baseURL: option.baseUrl,
    name: option.provider,
    fetch: option.provider === "gemini" ? geminiFetch(guarded) : guarded,
  });
  const model = provider.chat(option.id);
  // OpenRouter's credit check reserves the full max_tokens amount. Its catalog
  // maximum (16k) exceeded the remaining credit in a real chat and caused a
  // silent-looking turn failure; cap the request while retaining streaming.
  return option.provider === "openrouter" ? withMaxOutputTokens(model, 12_000) : model;
}
