import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/*
 * The model catalog: every provider the workspace holds a key for, and the
 * models a probe answered or a listing named — the probe field says which.
 *
 * Verified 2026-10-21 against the live keys. The default was Groq from
 * 2026-11-05 until the owner moved it to GLM 5.3 Flash on TheHive on
 * 2026-11-11; Groq and Gemini stay in the catalog as picker choices. NVIDIA advertises 83 models in its listing but most return 410
 * end-of-life or 404 not-found (meta/llama-3.2-11b-vision-instruct went 410
 * 2026-11-05 and was removed). Shipping an entry that does not answer is
 * worse than omitting it —
 * the owner picks it, the turn fails, and the failure looks like a bug in
 * Polymath rather than in the account. Provider account state (balance, quota)
 * stays operator data: it never renders on a product page.
 *
 * The `probe` field records how each entry was verified, so a later reader can
 * tell a live model from one carried forward on a listing alone. Entries marked
 * "listing" were added 2026-10-24 from the mnfst/awesome-free-llm-apis catalog
 * without a live probe — they surface only when their key is set, and a failing
 * one is removed on first failed probe, not shipped to the picker.
 *
 * Provider quotas and credit change over time. A successful model listing or
 * short probe does not guarantee that a full chat request fits current account
 * limits, so runtime failures are surfaced in the transcript with a safe,
 * actionable explanation. OpenRouter's high catalog output maximum is capped at
 * the request boundary for credit-limited accounts.
 */

type ModelProviderId =
  | "gemini"
  | "groq"
  | "ai-gateway"
  | "nvidia"
  | "openai"
  | "cohere"
  | "mistral"
  | "ovh"
  | "zai"
  | "mercury"
  | "thehive"
  | "radium"
  | "openrouter"
  | "anthropic";

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
  /**
   * USD per million tokens. A free-tier model carries 0, never a missing price:
   * the usage ledger prices every call from this field, and a model with no
   * price is how Spending came to say "unpriced". Figures are estimates from
   * provider pricing pages as of 2026-11-12; correct them here, in one place.
   */
  price: ModelPrice;
  /** How this entry was verified, and when. */
  probe: string;
};

export type ModelPrice = { inputPerMillion: number; outputPerMillion: number };

export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    label: "GPT-OSS 120B (Groq)",
    note: "Large open model on Groq's fast inference; works with tools.",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    price: { inputPerMillion: 0.15, outputPerMillion: 0.75 },
    probe: "live 2026-11-05 (chat and tool calling verified; default until 2026-11-11)",
  },
  {
    id: "qwen/qwen3.8-27b",
    provider: "groq",
    label: "Qwen 3.8 27B (Groq)",
    note: "Smaller and quicker; good for short turns.",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    price: { inputPerMillion: 0.29, outputPerMillion: 0.59 },
    probe: "live 2026-11-05; tool calling verified 2026-10-21",
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "gemini",
    label: "Gemini 3.5 Flash Lite",
    note: "Free tier, fast; reserved for narrower roles the owner will pick later.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: "GEMINI_API_KEY",
    price: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    probe: "live 2026-10-21; former default until the 2026-11-05 Groq-first decision",
  },
  {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    provider: "nvidia",
    label: "Nemotron 3.5 Lightning 30B (NVIDIA)",
    note: "Fast small reasoning model on NVIDIA's free developer tier.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-10-24",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    provider: "nvidia",
    label: "Nemotron 3 Ultra 550B (NVIDIA)",
    note: "NVIDIA's largest open reasoning model, free developer tier.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-10-24",
  },
  {
    id: "openai/gpt-oss-20b",
    provider: "nvidia",
    label: "GPT-OSS 20B (NVIDIA)",
    note: "Small open model on NVIDIA's free developer tier.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-10-24",
  },
  {
    id: "deepseek-ai/deepseek-v4.1-flash",
    provider: "nvidia",
    label: "DeepSeek V4.1 Flash (NVIDIA)",
    note: "DeepSeek on NVIDIA's free developer tier; 40 RPM / 10k RPD.",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "listing 2026-10-27 (NVIDIA catalogue); chat unprobed — no key on this machine",
  },
  {
    id: "command-r7b-12-2024",
    provider: "cohere",
    label: "Command R7B (Cohere)",
    note: "Fast Cohere model on the free trial key (1,000 calls/month, non-commercial).",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    keyEnv: "COHERE_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "listing 2026-10-24 (mnfst catalog); OpenAI-compat endpoint",
  },
  {
    id: "command-a-reasoning-08-2025",
    provider: "cohere",
    label: "Command A Reasoning (Cohere)",
    note: "Cohere's largest reasoning model, same trial key.",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    keyEnv: "COHERE_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "listing 2026-10-24 (mnfst catalog); OpenAI-compat endpoint",
  },
  {
    id: "mistral-small-latest",
    provider: "mistral",
    label: "Mistral Small (Mistral)",
    note: "Free mode, no card; prompts may train Mistral models unless opted out.",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-10-24 (codestral answered; small is rate-limit-gated ~1 RPS)",
  },
  {
    id: "codestral-latest",
    provider: "mistral",
    label: "Codestral (Mistral)",
    note: "Code-focused model on the same free mode.",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "Qwen3.5-397B-A17B",
    provider: "ovh",
    label: "Qwen 3.5 397B (OVHcloud)",
    note: "EU-hosted open model; 2 RPM on the free tier makes it for slow one-offs.",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyEnv: "OVH_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "gpt-oss-120b",
    provider: "ovh",
    label: "GPT-OSS 120B (OVHcloud)",
    note: "Same EU free tier; 2 RPM per model.",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyEnv: "OVH_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "listing 2026-10-24 (mnfst catalog)",
  },
  {
    id: "glm-4.7-flash",
    provider: "zai",
    label: "GLM 4.7 Flash (Z AI)",
    note: "Free reasoning model on Z AI's international endpoint.",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-10-24 (glm-4.5-flash answered; 4.7 intermittent 1305)",
  },
  {
    id: "glm-4.5-flash",
    provider: "zai",
    label: "GLM 4.5 Flash (Z AI)",
    note: "Steadier free fallback on the same Z AI key.",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-10-24",
  },
  {
    id: "mercury-3",
    provider: "mercury",
    label: "Mercury 3 (Inception)",
    note: "Diffusion-token model on the 100M free-token grant; 1M context, fast. The assessor profile's designed-in default.",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    keyEnv: "MERCURY_API_KEY",
    price: { inputPerMillion: 0.25, outputPerMillion: 0.75 },
    probe: "live 2026-10-30 (chat, tool calls with index, tool-result round-trip, SSE streaming verified)",
  },
  {
    id: "mercury-voice",
    provider: "mercury",
    label: "Mercury Voice (Inception)",
    note: "Voice-tuned chat model for latency-sensitive agent turns; reserved for a later-wave voice surface — not yet served to this account.",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    keyEnv: "MERCURY_API_KEY",
    price: { inputPerMillion: 0.25, outputPerMillion: 0.75 },
    probe:
      "listing 2026-11-02 (docs.inceptionlabs.ai models page); absent from this account's live GET /v1/models on 2026-11-02 — never a default, remove on first failed probe",
  },
  {
    id: "zai-org/glm-5.3-flash",
    provider: "thehive",
    label: "GLM 5.3 Flash (TheHive)",
    note: "Default. Zhipu's reasoning model on TheHive's hosted inference; paid from the account balance.",
    baseUrl: "https://api-cdn.thehive.ai/api/v3",
    keyEnv: "THEHIVEAI_API_KEY",
    price: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    probe:
      "live 2026-11-07 (chat, streaming, json_schema structured output, tool calling verified); chat re-probed 2026-11-11; current default",
  },
  {
    id: "deepseek-ai/deepseek-v4.1-flash-1017",
    provider: "thehive",
    label: "DeepSeek V4.1 Flash (TheHive)",
    note: "DeepSeek's fast reasoning model on TheHive's hosted inference.",
    baseUrl: "https://api-cdn.thehive.ai/api/v3",
    keyEnv: "THEHIVEAI_API_KEY",
    price: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
    probe: "live 2026-11-07 (chat, streaming, json_schema structured output, tool calling verified)",
  },
  {
    id: "clarke-1.0",
    provider: "radium",
    label: "Clarke 1.0 (Radium)",
    note: "Radium's balanced model; the provider documents a 1M-token context.",
    baseUrl: "https://api.radium.cloud/v1",
    keyEnv: "RADIUM_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-11-11 (chat, tool calling and SSE streaming verified; context size not probed)",
  },
  {
    id: "hal-1.0",
    provider: "radium",
    label: "HAL 1.0 (Radium)",
    note: "Radium's reasoning model for harder turns.",
    baseUrl: "https://api.radium.cloud/v1",
    keyEnv: "RADIUM_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-11-11 (chat and tool calling verified)",
  },
  {
    id: "tycho-1.0",
    provider: "radium",
    label: "Tycho 1.0 (Radium)",
    note: "Radium's fast model for short turns.",
    baseUrl: "https://api.radium.cloud/v1",
    keyEnv: "RADIUM_API_KEY",
    price: { inputPerMillion: 0, outputPerMillion: 0 },
    probe: "live 2026-11-11 (chat and tool calling verified)",
  },
  {
    id: "deepseek/deepseek-chat",
    provider: "openrouter",
    label: "DeepSeek Chat (OpenRouter)",
    note: "Paid DeepSeek route on the OpenRouter key; tool calling unverified.",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    price: { inputPerMillion: 0.27, outputPerMillion: 1.1 },
    probe: "live 2026-10-27 (arithmetic check returned 51, not an echo)",
  },
  {
    id: "deepseek/deepseek-v3.2",
    provider: "openrouter",
    label: "DeepSeek V3.2 (OpenRouter)",
    note: "Paid DeepSeek route on the OpenRouter key; tool calling unverified.",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    price: { inputPerMillion: 0.28, outputPerMillion: 0.42 },
    probe: "live 2026-10-27 (arithmetic check returned 51, not an echo)",
  },
  {
    id: "gpt-6.1-terra",
    provider: "openai",
    label: "GPT-6.1 Terra (OpenAI)",
    note: "Paid strong model for hard synthesis and drafting; routed by task difficulty.",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    price: { inputPerMillion: 2.5, outputPerMillion: 15.0 },
    probe:
      "listing 2026-10-29 (models endpoint answered; chat turn blocked by zero account credits — chat probed in Task 3's live eval run)",
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 Mini (OpenAI)",
    note: "Cheaper paid route for routine paid work",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    price: { inputPerMillion: 0.75, outputPerMillion: 4.5 },
    probe:
      "listing 2026-10-29 (models endpoint answered; chat turn blocked by zero account credits — chat probed in Task 3's live eval run)",
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5 (Anthropic)",
    note: "Anthropic's strong general model; reached through its OpenAI-compatible endpoint, on the user's own key.",
    baseUrl: "https://api.anthropic.com/v1/",
    keyEnv: "ANTHROPIC_API_KEY",
    price: { inputPerMillion: 3, outputPerMillion: 15 },
    probe:
      "listing 2026-11-12 (Anthropic OpenAI-compatible endpoint documented); chat unprobed — no key on this machine",
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5 (Anthropic)",
    note: "Anthropic's fast, low-cost model; same endpoint and key.",
    baseUrl: "https://api.anthropic.com/v1/",
    keyEnv: "ANTHROPIC_API_KEY",
    price: { inputPerMillion: 1, outputPerMillion: 5 },
    probe:
      "listing 2026-11-12 (Anthropic OpenAI-compatible endpoint documented); chat unprobed — no key on this machine",
  },
];

/** The model used when nothing is chosen. */
export const DEFAULT_MODEL_ID = "zai-org/glm-5.3-flash";

/**
 * The assessor profile's designed-in default (superagent spec §9, owner
 * directive 2026-11-02): Mercury 3 on the 100M-token grant. Settings-resolvable
 * like any run model — a profile's `model_policy.primary` overrides it — so
 * another provider takes over by configuration alone. The superagent assessor
 * module resolves through the catalog; it never hardcodes the id.
 */
export const ASSESSOR_MODEL_ID = "mercury-3";

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

/**
 * One resolution order for a run's model: a profile's pinned primary when it
 * names a catalog entry, else the catalog default. The eve runtime resolves
 * the same way on a run's first turn; the onboarding credential gate calls
 * this before minting a run, so the two can never disagree.
 */
export function resolveRunModel(modelPolicy: unknown): ModelOption | null {
  const primary =
    typeof modelPolicy === "object" && modelPolicy !== null ? (modelPolicy as { primary?: unknown }).primary : null;
  return modelById(resolveModelId(primary));
}

/**
 * A real model instance for a direct AI SDK call — the one pattern a
 * no-run, no-stream server action needs (the onboarding assist; an eve run
 * never enters the picture). Every catalog entry's baseUrl is the
 * OpenAI-compatible chat endpoint, so one provider factory with the entry's
 * own credentials speaks for all of them, exactly as the runtime would on a
 * run's first turn.
 */
export function chatModel(option: ModelOption, env: Record<string, string | undefined> = process.env): LanguageModel {
  const apiKey = env[option.keyEnv];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`${option.keyEnv} is not set, so ${option.label} cannot be called.`);
  }
  return createOpenAI({ apiKey, baseURL: option.baseUrl }).chat(option.id);
}

/*
 * Providers, derived from the catalog: a provider is whatever its models share
 * (endpoint, key variable). A workspace key is held per provider, so adding a
 * catalog entry for a new provider makes it key-able with no second list.
 */
export type KeyProvider = { id: ModelProviderId; label: string; baseUrl: string; keyEnv: string };

const PROVIDER_LABELS: Record<ModelProviderId, string> = {
  gemini: "Google Gemini",
  groq: "Groq",
  "ai-gateway": "AI Gateway",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  cohere: "Cohere",
  mistral: "Mistral",
  ovh: "OVHcloud",
  zai: "Z AI",
  mercury: "Inception (Mercury)",
  thehive: "TheHive",
  radium: "Radium",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
};

export function keyProviders(): KeyProvider[] {
  const seen = new Map<ModelProviderId, KeyProvider>();
  for (const model of MODEL_CATALOG) {
    if (!seen.has(model.provider)) {
      seen.set(model.provider, {
        id: model.provider,
        label: PROVIDER_LABELS[model.provider],
        baseUrl: model.baseUrl,
        keyEnv: model.keyEnv,
      });
    }
  }
  return [...seen.values()];
}

export function keyProviderById(id: string): KeyProvider | null {
  return keyProviders().find((provider) => provider.id === id) ?? null;
}

/** The provider's cheapest catalog model: what a user's own key serves when the request named another provider's. */
export function cheapestModelOf(provider: string): ModelOption | null {
  const cost = (m: ModelOption) => m.price.inputPerMillion + m.price.outputPerMillion;
  return (
    MODEL_CATALOG.filter((m) => m.provider === provider).sort(
      (a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

/** The call's cost in USD, or null for a model the catalog does not know (unpriced, never zero). */
export function priceCall(modelId: string, inputTokens: number, outputTokens: number): number | null {
  const model = modelById(modelId);
  if (!model) return null;
  return (inputTokens * model.price.inputPerMillion + outputTokens * model.price.outputPerMillion) / 1_000_000;
}

/** A model served by `apiKey` instead of the deployment's env: the one provider factory every direct AI SDK call uses. */
export function chatModelWithKey(option: ModelOption, apiKey: string): LanguageModel {
  return createOpenAI({ apiKey, baseURL: option.baseUrl }).chat(option.id);
}
