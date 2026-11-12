import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { geminiFetch } from "../../polymath/agent/lib/gemini-openai";
import { modelById } from "../../../src/domains/agents/models";

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

/** The catalog-served model for a frozen id, failing loudly instead of substituting. */
function modelFromCatalog(runModel: string) {
  // A frozen id that left the catalog (a probe-retired entry) must fail the
  // run loudly: falling back would record one model on the run row while
  // another answered — the lie the spend contract forbids.
  const entry = modelById(runModel);
  if (!entry) {
    throw new Error(
      `Model "${runModel}" is not in the catalog. Choose another model; the run's frozen model is never silently substituted.`,
    );
  }
  const apiKey = (process.env[entry.keyEnv] ?? "").trim();
  if (!apiKey) {
    // A model whose key vanished from the deployment must not silently fall
    // back to a different provider. The message names the restart case: a dev
    // server inherits its environment at boot.
    throw new Error(
      `${entry.keyEnv} is not set, so ${entry.label} cannot run. Set ${entry.keyEnv} and restart the agent process (a dev server only sees .env as it was at boot), or choose another model.`,
    );
  }
  const provider = createOpenAI({
    apiKey,
    baseURL: entry.baseUrl,
    name: entry.provider,
    ...(entry.provider === "gemini" ? { fetch: geminiFetch(fetch) } : {}),
  });
  return provider.chat(entry.id);
}

function specialistModel(runModel?: string | null) {
  if (runModel && runModel.trim()) return modelFromCatalog(runModel.trim());
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
      "step.started": (_event, ctx) => {
        const fromSession = ctx.session.auth.current?.attributes?.model;
        const runModel = typeof fromSession === "string" ? fromSession : process.env.AXIOM_RUN_MODEL;
        return {
          model: specialistModel(runModel),
          modelContextWindowTokens: 128_000,
        };
      },
    },
  }),
});
