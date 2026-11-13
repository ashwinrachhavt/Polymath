import type { LanguageModel } from "ai";
import {
  DEFAULT_MODEL_ID,
  resolveRunModel,
  availableModels,
  cheapestModelOf,
  MODEL_CATALOG,
  chatModelWithKey,
  modelById,
  type ModelOption,
} from "@/domains/agents/models";
import { embeddingProvider, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import { geminiProvider } from "@/integrations/generation/gemini";
import { openAICompatibleProvider } from "@/integrations/generation/openai-compatible";
import {
  GenerationUnconfiguredError,
  generationProvider,
  metered,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { hasOwnKey, listKeyStatus, loadOwnKeys } from "./keys";
import { houseCallsThisWeek, recordModelCall } from "./ledger";
import { getPlan, weeklyAllowance } from "./plans";
import type { KeySource, Plan, UsagePurpose } from "./schema";

/*
 * THE resolver: the one place that decides which key and model serve a model
 * call for a workspace, whether the call may happen, and that it is recorded.
 * Every call site (chat steps, generation, grading, direct SDK calls,
 * embeddings) asks here; none reads a provider key or a plan itself.
 *
 * Precedence, always:
 *   1. the workspace's own key. If it holds one for the requested model's
 *      provider, that provider serves the requested model. Otherwise its
 *      oldest key serves that provider's cheapest catalog model. Own keys are
 *      never limited and never touch the house allowance.
 *   2. else the house key (the deployment's env), while this week's house calls
 *      are under the plan's allowance (billing/plans.ts).
 *   3. else AllowanceExhaustedError: add a key or upgrade.
 * Embeddings take the same order but are exempt from the allowance in step 2:
 * capture and search must not stop on the free plan.
 *
 * The allowance check reads the ledger and the call records after it returns,
 * so concurrent calls can overshoot by the number in flight. Bounded and
 * acceptable for a weekly cap; it is not a hard financial limit.
 */

/*
 * A GenerationUnconfiguredError on purpose: every background path already
 * degrades quietly on "no model for this workspace" (capture keeps its
 * deterministic tiers, critique skips) instead of retrying a job that cannot
 * succeed this week. The message is the authored, user-facing one.
 */
export class AllowanceExhaustedError extends GenerationUnconfiguredError {
  constructor(
    readonly plan: Plan,
    readonly allowance: number,
  ) {
    super();
    this.message =
      plan === "pro"
        ? "Your Pro allowance for this week is used up. Add your own key in Settings to keep going, or wait for it to reset."
        : "Your free AI allowance for this week is used up. Add your own key in Settings, or upgrade to Pro.";
    this.name = "AllowanceExhaustedError";
  }
}

/** The house has no key for the model, or the workspace's own key cannot be used. Message is safe to show. */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

type Env = Record<string, string | undefined>;

export type ModelRoute = { source: KeySource; option: ModelOption; apiKey: string };

function catalogOption(requestedId: string | null | undefined): ModelOption {
  const wanted = requestedId ?? DEFAULT_MODEL_ID;
  // A run's frozen id that left the catalog fails loudly: substituting the default would record one model
  // on the run while another answered.
  const option = modelById(wanted);
  if (!option) {
    throw new ModelUnavailableError(
      `Model "${wanted}" is not in the catalog. Choose another model; the run's frozen model is never silently substituted.`,
    );
  }
  return option;
}

/** The deployment's own key for a model, with no workspace and no allowance (evals, the TUI, operator jobs). */
export function houseRoute(requestedId: string | null | undefined, env: Env = process.env): ModelRoute {
  const option = catalogOption(requestedId);
  const apiKey = (env[option.keyEnv] ?? "").trim();
  if (!apiKey) {
    throw new ModelUnavailableError(
      `${option.keyEnv} is not set, so ${option.label} cannot run. Set ${option.keyEnv} and restart the agent process (a dev server only sees .env as it was at boot), or choose another model.`,
    );
  }
  return { source: "house", option, apiKey };
}

async function assertHouseAllowance(workspaceId: string, purpose: UsagePurpose): Promise<void> {
  if (purpose === "embedding") return;
  const plan = await getPlan(workspaceId);
  const allowance = weeklyAllowance(plan);
  if ((await houseCallsThisWeek(workspaceId)) >= allowance) throw new AllowanceExhaustedError(plan, allowance);
}

async function ownKeys(workspaceId: string, env: Env) {
  try {
    return await loadOwnKeys(workspaceId, env);
  } catch {
    // A stored key that cannot be opened must not silently bill the house instead.
    throw new ModelUnavailableError("A saved API key could not be read. Re-add it in Settings.");
  }
}

/** Chat steps and direct SDK calls: the route for `requestedId` (a catalog id, or the default). */
export function resolveModelRoute(
  workspaceId: string,
  requestedId: string | null | undefined,
  purpose: UsagePurpose,
  env: Env = process.env,
): Promise<ModelRoute> {
  return route(workspaceId, requestedId, purpose, env, true);
}

async function route(
  workspaceId: string,
  requestedId: string | null | undefined,
  purpose: UsagePurpose,
  env: Env,
  requireHouseKey: boolean,
): Promise<ModelRoute> {
  const requested = catalogOption(requestedId);
  const own = await ownKeys(workspaceId, env);
  if (own.length > 0) {
    const match = own.find((key) => key.provider === requested.provider);
    if (match) return { source: "own", option: requested, apiKey: match.apiKey };
    const substitute = cheapestModelOf(own[0].provider);
    if (substitute) return { source: "own", option: substitute, apiKey: own[0].apiKey };
  }
  await assertHouseAllowance(workspaceId, purpose);
  // A run freezes its model before any step runs; a house key missing at that moment is the first
  // step's error to raise (as it always was), not a reason to refuse the run's creation.
  return requireHouseKey ? houseRoute(requested.id, env) : { source: "house", option: requested, apiKey: "" };
}

/** The route for a chat session: a workspace resolves through its keys and allowance; a session with none (evals, the TUI) uses the house env. */
export function resolveSessionRoute(
  workspaceId: string | null,
  requestedId: string | null | undefined,
  env: Env = process.env,
) {
  return workspaceId
    ? resolveModelRoute(workspaceId, requestedId, "chat", env)
    : Promise.resolve(houseRoute(requestedId, env));
}

/**
 * The model a new run freezes: the profile's pinned primary (else the catalog
 * default) as the workspace will actually be served, so `agent_runs.model` is
 * the model that answers. Throws the allowance or key error at start, where
 * the person can still act on it, not on the first step.
 */
export async function resolveRunModelFor(
  workspaceId: string,
  modelPolicy: unknown,
  env: Env = process.env,
): Promise<string | null> {
  const requested = resolveRunModel(modelPolicy);
  if (!requested) return null;
  return (await route(workspaceId, requested.id, "chat", env, false)).option.id;
}

/**
 * The models the picker may offer a workspace: those its own keys can serve,
 * plus those the house can. Offering one neither can serve would freeze a run
 * that fails on its first step.
 */
export async function selectableModels(workspaceId: string, env: Env = process.env): Promise<ModelOption[]> {
  const own = new Set((await listKeyStatus(workspaceId)).map((key) => key.provider));
  const house = new Set(availableModels(env).map((model) => model.id));
  return MODEL_CATALOG.filter((model) => own.has(model.provider) || house.has(model.id));
}

/** How a chat step's cost is attributed: own whenever the workspace holds a key, since the resolver prefers it. */
export async function keySourceFor(workspaceId: string): Promise<KeySource> {
  return (await hasOwnKey(workspaceId)) ? "own" : "house";
}

/**
 * A direct AI SDK call (facts, memory, onboarding). Call `record` once with
 * the SDK result's usage; without it the call is invisible to the allowance.
 */
export async function resolveLanguageModel(
  workspaceId: string,
  requestedId: string | null | undefined,
  purpose: Exclude<UsagePurpose, "embedding">,
  env: Env = process.env,
): Promise<{
  model: LanguageModel;
  option: ModelOption;
  source: KeySource;
  record(usage?: { inputTokens?: number; outputTokens?: number }): Promise<void>;
}> {
  const route = await resolveModelRoute(workspaceId, requestedId, purpose, env);
  return {
    model: chatModelWithKey(route.option, route.apiKey),
    option: route.option,
    source: route.source,
    record: (usage) =>
      recordModelCall({
        workspaceId,
        purpose,
        provider: route.option.provider,
        model: route.option.id,
        keySource: route.source,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }),
  };
}

const OWN_PREFIX = "own:";

/** An adapter name is `<registryId>:<model>`; the ledger keeps the model alone. */
function modelOf(adapterName: string): string {
  const name = adapterName.replace(OWN_PREFIX, "");
  return name.slice(name.indexOf(":") + 1);
}

/**
 * The generation route (summaries, quizzes, flashcards, zettels, drafts,
 * grading). The house route is the existing free-first chain, unchanged; the
 * own route is the workspace's oldest key on that provider's cheapest model.
 * Own providers carry registryId `own:<provider>`, which has no registry
 * entry, so the per-provider free-tier quota (withQuota) rightly skips them.
 * Every call is recorded to the ledger.
 */
export async function resolveGeneration(
  workspaceId: string,
  purpose: "generation" | "grading",
  deps: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<GenerationProvider> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const own = await ownKeys(workspaceId, env);
  let provider: GenerationProvider;
  let source: KeySource;
  if (own.length > 0) {
    const option = cheapestModelOf(own[0].provider);
    if (!option) throw new ModelUnavailableError("That provider has no model to call.");
    provider =
      option.provider === "gemini"
        ? {
            ...geminiProvider({ GEMINI_API_KEY: own[0].apiKey, GEMINI_MODEL: option.id }, fetchImpl),
            registryId: `${OWN_PREFIX}gemini`,
          }
        : openAICompatibleProvider(
            {
              baseUrl: option.baseUrl,
              apiKey: own[0].apiKey,
              model: option.id,
              registryId: `${OWN_PREFIX}${option.provider}`,
              headers: option.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : undefined,
              streamUsage: option.provider === "openrouter",
            },
            fetchImpl,
          );
    source = "own";
  } else {
    provider = generationProvider(env, fetchImpl);
    // E2E journeys run a deterministic fixture that costs nothing and must never exhaust a test workspace.
    if (provider.registryId === "fixture") return provider;
    await assertHouseAllowance(workspaceId, purpose);
    source = "house";
  }
  return metered(provider, (call) =>
    recordModelCall({
      workspaceId,
      purpose,
      provider: call.provider.replace(OWN_PREFIX, ""),
      model: modelOf(call.model),
      keySource: source,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
    }),
  );
}

/** text-embedding-3-small list price; the one embedding model the product uses. */
const EMBEDDING_USD_PER_MILLION_TOKENS = 0.02;

/**
 * Embeddings: the workspace's OpenRouter or OpenAI key if it holds one, else
 * the house chain. Exempt from the allowance, but recorded. Providers report no
 * token usage here, so tokens are estimated at four characters each.
 */
export async function resolveEmbedding(workspaceId: string, env: Env = process.env): Promise<EmbeddingProvider> {
  const own = await ownKeys(workspaceId, env);
  const key = own.find((k) => k.provider === "openrouter") ?? own.find((k) => k.provider === "openai");
  const source: KeySource = key ? "own" : "house";
  const inner = key
    ? embeddingProvider(
        key.provider === "openrouter"
          ? { EMBEDDING_PROVIDER: "openrouter", OPENROUTER_API_KEY: key.apiKey, EMBEDDING_MODEL: env.EMBEDDING_MODEL }
          : { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: key.apiKey },
      )
    : embeddingProvider(env);
  const [providerId, ...rest] = inner.model.split(":");
  return {
    model: inner.model,
    async embed(values, options) {
      const vectors = await inner.embed(values, options);
      const tokens = Math.ceil(values.reduce((sum, v) => sum + v.length, 0) / 4);
      await recordModelCall({
        workspaceId,
        purpose: "embedding",
        provider: providerId,
        model: rest.join(":"),
        keySource: source,
        inputTokens: tokens,
        outputTokens: 0,
        costUsd: (tokens * EMBEDDING_USD_PER_MILLION_TOKENS) / 1_000_000,
      });
      return vectors;
    },
  };
}
