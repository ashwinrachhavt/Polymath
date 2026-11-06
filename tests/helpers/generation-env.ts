import { MODEL_CATALOG } from "@/domains/agents/models";

/** A keyless fixture must stay keyless as the supported provider catalog grows. */
export const GENERATION_ENV_KEYS = [
  ...new Set([
    "GENERATION_PROVIDER",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "INCEPTION_API_KEY",
    ...MODEL_CATALOG.map((model) => model.keyEnv),
  ]),
];
