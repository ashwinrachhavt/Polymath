import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

/*
 * The specialist agent: one shared runtime for every hired profile
 * (specialist:<slug>, specialist:custom:<name>). The role is NOT here — it
 * arrives with the run as an `axiom-specialist-brief v1` context message (see
 * src/domains/agents/eve-driver.ts for why the brief travels with the create
 * call rather than being resolved here from the database).
 *
 * The model resolver mirrors alfred's: credentials read per step, because the
 * deployed bundle's module-scope env reads did not see Vercel's runtime env.
 */
function specialistModel() {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
  const baseURL =
    process.env.OPENAI_BASE_URL ??
    (apiKey.startsWith("sk-or-") ? "https://openrouter.ai/api/v1" : "https://api.groq.com/openai/v1");
  const provider = createOpenAI({ apiKey, baseURL, name: "groq" });
  return provider.chat("openai/gpt-oss-120b");
}

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => ({ model: specialistModel(), modelContextWindowTokens: 128_000 }),
    },
  }),
});
