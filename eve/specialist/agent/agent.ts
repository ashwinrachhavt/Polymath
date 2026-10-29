import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { geminiFetch } from "../../polymath/agent/lib/gemini-openai";

/*
 * The specialist agent: one shared runtime for every hired profile
 * (specialist:<slug>, specialist:custom:<name>). The role is NOT here — it
 * arrives with the run as an `axiom-specialist-brief v1` context message (see
 * src/domains/agents/eve-driver.ts for why the brief travels with the create
 * call rather than being resolved here from the database).
 *
 * The model resolver mirrors polymath's: Gemini through its OpenAI-compatible
 * endpoint, credentials read per step (the deployed bundle's module-scope env
 * reads did not see Vercel's runtime env), and the same `geminiFetch` repair for
 * streaming tool calls. Two agents on two providers would mean two quota
 * stories and two ways for a tool call to fail.
 */
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

function specialistModel() {
  // Same blank-key guard as polymath: a set-but-empty GEMINI_API_KEY must not
  // shadow a populated fallback.
  const apiKey =
    [process.env.GEMINI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY].find((key) => key && key.length > 0) ?? "";
  const provider = createOpenAI({
    apiKey,
    baseURL: GEMINI_OPENAI_BASE,
    name: "gemini",
    fetch: geminiFetch(),
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
      "step.started": () => ({ model: specialistModel(), modelContextWindowTokens: 128_000 }),
    },
  }),
});
