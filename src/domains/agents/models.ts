/*
 * The model catalog: every provider the workspace holds a key for, and only the
 * models that actually answered a probe.
 *
 * Verified 2026-10-21 against the live keys. NVIDIA advertises 83 models in its
 * listing but most return 410 end-of-life or 404 not-found; LLM7 lists 70 and
 * returns "Insufficient balance" on every call. Shipping an entry that does not
 * answer is worse than omitting it — the owner picks it, the turn fails, and the
 * failure looks like a bug in Polymath rather than in the account.
 *
 * The `probe` field records how each entry was verified, so a later reader can
 * tell a live model from one carried forward on a listing alone.
 */

export type ModelProviderId = "gemini" | "groq" | "ai-gateway" | "nvidia";

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
export const UNUSABLE_PROVIDERS: ReadonlyArray<{ id: string; label: string; reason: string }> = [
  {
    id: "llm7",
    label: "LLM7",
    reason: "The key is set but every call returns “Insufficient balance”. Top up the account to use it.",
  },
];

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
