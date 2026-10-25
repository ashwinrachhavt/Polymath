/*
 * The model catalog: every provider the workspace holds a key for, and only the
 * models that actually answered a probe.
 *
 * Verified 2026-10-21 against the live keys. NVIDIA advertises 83 models in its
 * listing but most return 410 end-of-life or 404 not-found; LLM7 lists 70 and
 * returns "Insufficient balance" on every call. Shipping an entry that does not
 * answer is worse than omitting it — the owner picks it, the turn fails, and the
 * failure looks like a bug in Polymath rather than in the account. Provider
 * account state (balance, quota) stays operator data: it never renders on a
 * product page.
 *
 * The `probe` field records how each entry was verified, so a later reader can
 * tell a live model from one carried forward on a listing alone. Entries marked
 * "listing" were added 2026-10-24 from the mnfst/awesome-free-llm-apis catalog
 * without a live probe — they surface only when their key is set, and a failing
 * one is removed on first failed probe, not shipped to the picker.
 */

export type ModelProviderId =
  | "gemini"
  | "groq"
  | "ai-gateway"
  | "nvidia"
  | "cohere"
  | "mistral"
  | "kilo"
  | "ovh"
  | "zai"
  | "openrouter-free";

export type ModelOption = {
  /** The string stored in `model_policy.primary` and frozen into a run. */
  id: string;
  provider: ModelProviderId;
  /** What the picker shows. */
  label: string;
  /** One line: what this model is for. */
  note: string;
  /** Base URL for the OpenAI-compatible chat endpoint. */
  baseUrl: string;
  /** Env var holding the key. A missing key hides the entry. */
  keyEnv: string;
  /** Whether the model works with tool calls. */
  tools: boolean;
  /** How this entry was verified, and when. */
  probe: string;
};

/*
 * Providers whose every model failed a live probe. Listed so the UI can say why
 * they are absent rather than pretending the workspace never added them.
 */
export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    id: "gemini-3.5-flash-lite",
    provider: "gemini",
    label: "Gemini 3.5 Flash Lite",
    note: "Default. Free tier, fast, works with tools.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: "GEMINI_API_KEY",
    tools: true,
    probe: "live 2026-10-21 (current default)",
  },
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    label: "GPT-OSS 120B (Groq)",
    note: "Large open model on Groq's fast inference.",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    tools: true,
    probe: "live 2026-10-21",
  },
  {
    id: "qwen/qwen3.8-27b",
    provider: "groq",
    label: "Qwen 3.8 27B (Groq)",
    note: "Smaller and quicker; good for short turns.",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    tools: true,
    probe: "live 2026-10-21",
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "ai-gateway",
    label: "GPT-4o mini (AI Gateway)",
    note: "Routed through Vercel's gateway; one key for many vendors.",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyEnv: "AI_GATEWAY_API_KEY",
    tools: true,
    probe: "live 2026-10-21",
  },
  {
    id: "alibaba/qwen-3-32b",
    provider: "ai-gateway",
    label: "Qwen 3 32B (AI Gateway)",
    note: "Open model via the gateway.",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyEnv: "AI_GATEWAY_API_KEY",
    tools: true,
    probe: "live 2026-10-21",
  },
  {
    id: "meta/llama-3.2-11b-vision-instruct",
    provider: "nvidia",
    label: "Llama 3.2 11B Vision (NVIDIA)",
    note: "The one NVIDIA model that answered; most others are end-of-life.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    tools: false,
    probe: "live 2026-10-21; tool calling unverified",
  },
  {
    id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    provider: "nvidia",
    label: "Nemotron Ultra 253B (NVIDIA)",
    note: "Open reasoning model on NVIDIA's free developer tier.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "openai/gpt-oss-20b",
    provider: "nvidia",
    label: "GPT-OSS 20B (NVIDIA)",
    note: "Small open model on NVIDIA's free developer tier.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "command-r7b-12-2024",
    provider: "cohere",
    label: "Command R7B (Cohere)",
    note: "Fast Cohere model on the free trial key (1,000 calls/month, non-commercial).",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    keyEnv: "COHERE_API_KEY",
    tools: true,
    probe: "listing 2026-10-24 (mnfst catalog); OpenAI-compat endpoint",
  },
  {
    id: "command-a-reasoning-08-2025",
    provider: "cohere",
    label: "Command A Reasoning (Cohere)",
    note: "Cohere's largest reasoning model, same trial key.",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    keyEnv: "COHERE_API_KEY",
    tools: true,
    probe: "listing 2026-10-24 (mnfst catalog); OpenAI-compat endpoint",
  },
  {
    id: "mistral-small-3-latest",
    provider: "mistral",
    label: "Mistral Small 4 (Mistral)",
    note: "Free mode, no card; prompts may train Mistral models unless opted out.",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    tools: true,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "codestral-latest",
    provider: "mistral",
    label: "Codestral (Mistral)",
    note: "Code-focused model on the same free mode.",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    tools: true,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "Qwen3.5-397B-A17B",
    provider: "ovh",
    label: "Qwen 3.5 397B (OVHcloud)",
    note: "EU-hosted open model; 2 RPM on the free tier makes it for slow one-offs.",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyEnv: "OVH_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "gpt-oss-120b",
    provider: "ovh",
    label: "GPT-OSS 120B (OVHcloud)",
    note: "Same EU free tier; 2 RPM per model.",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyEnv: "OVH_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "glm-4.7-flash",
    provider: "zai",
    label: "GLM 4.7 Flash (Z AI)",
    note: "Free reasoning model on Z AI's international endpoint.",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "deepseek/deepseek-r1:free",
    provider: "openrouter-free",
    label: "DeepSeek R1 (OpenRouter free)",
    note: "One of OpenRouter's :free models; 50 RPD per model by default.",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog); free pool rotates",
  },
  {
    id: "google/gemma-4-31b-it:free",
    provider: "openrouter-free",
    label: "Gemma 4 31B (OpenRouter free)",
    note: "Free Gemma with vision; shares the :free pool's 50 RPD.",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    tools: false,
    probe: "listing 2026-10-24 (mnfst catalog); free pool rotates",
  },
];

/** The model used when nothing is chosen, and the one every run used before this existed. */
export const DEFAULT_MODEL_ID = "gemini-3.5-flash-lite";

/** A model the workspace can actually call: its key is set. */
export function availableModels(env: Record<string, string | undefined> = process.env): ModelOption[] {
  return MODEL_CATALOG.filter((model) => {
    const key = env[model.keyEnv];
    return typeof key === "string" && key.trim().length > 0;
  });
}

export function modelById(id: string): ModelOption | null {
  return MODEL_CATALOG.find((model) => model.id === id) ?? null;
}

/**
 * The picker's value for a profile that has never chosen one. A stored model
 * that is no longer in the catalog (an old run's `claude-hive-…`) resolves to
 * the default rather than a dead id.
 */
export function resolveModelId(stored: unknown): string {
  return typeof stored === "string" && modelById(stored) ? stored : DEFAULT_MODEL_ID;
}
