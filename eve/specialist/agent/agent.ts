import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { geminiFetch } from "../../polymath/agent/lib/gemini-openai";
import { resolveSessionRoute } from "../../../src/domains/billing/resolver";

/*
 * The specialist agent: one shared runtime for every hired profile
 * (specialist:<slug>, specialist:custom:<name>). The role is NOT here — it
 * arrives with the run as an `axiom-specialist-brief v1` context message (see
 * src/domains/agents/eve-driver.ts for why the brief travels with the create
 * call rather than being resolved here from the database).
 *
 * The model for one step resolves like the polymath agent's: the run's frozen
 * id (the signed bridge token's model claim, published as a session
 * attribute) is looked up in the shared catalog (src/domains/agents/models.ts)
 * and served from that provider. Profiles that pin no model — and evals and
 * the TUI, which have no run row — fall back to Gemini, the default this agent
 * always ran. Before the catalog seam, a profile pinning mercury-3 still got
 * Gemini: the run row and the answering model disagreed, the same lie the
 * spend contract forbids.
 */
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/** The model for a frozen id, served by the billing resolver: the workspace's own key, else the house key under the allowance. */
async function modelFromCatalog(workspaceId: string | null, runModel: string) {
  const route = await resolveSessionRoute(workspaceId, runModel);
  const provider = createOpenAI({
    apiKey: route.apiKey,
    baseURL: route.option.baseUrl,
    name: route.option.provider,
    ...(route.option.provider === "gemini" ? { fetch: geminiFetch(fetch) } : {}),
  });
  return provider.chat(route.option.id);
}

async function specialistModel(workspaceId: string | null, runModel?: string | null) {
  if (runModel && runModel.trim()) return modelFromCatalog(workspaceId, runModel.trim());
  // Same blank-key guard as polymath: a set-but-empty GEMINI_API_KEY must not
  // shadow a populated fallback.
  const apiKey =
    [process.env.GEMINI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY].find((key) => key && key.length > 0) ?? "";
  const provider = createOpenAI({
    apiKey,
    baseURL: GEMINI_OPENAI_BASE,
    name: "gemini",
    fetch: geminiFetch(fetch),
  });
  return provider.chat(process.env.GEMINI_AGENT_MODEL || GEMINI_DEFAULT_MODEL);
}

export default defineAgent({
  // No shell, filesystem, or glob/grep tools: a specialist reaches the world
  // through the authored, policy-gated tools in agent/tools/. Same reasoning as
  // the polymath agent, and it keeps the request schema small on every step.
  defaultTools: false,
  model: defineDynamic({
    events: {
      // The frozen model rides in the signed bridge token, which the channel
      // publishes as a session attribute; eve has no per-run config channel
      // before the first step. The env var is the fallback for evals and the
      // local TUI, which have no run row.
      "step.started": async (_event, ctx) => {
        const attributes = ctx.session.auth.current?.attributes;
        const fromSession = attributes?.model;
        const runModel = typeof fromSession === "string" ? fromSession : process.env.AXIOM_RUN_MODEL;
        const workspaceId = typeof attributes?.workspaceId === "string" ? attributes.workspaceId : null;
        return {
          model: await specialistModel(workspaceId, runModel),
          modelContextWindowTokens: 128_000,
        };
      },
    },
  }),
});
