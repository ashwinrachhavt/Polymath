import { createOpenAI } from "@ai-sdk/openai";
import { withMaxOutputTokens } from "../../../../src/domains/agents/model-output-limit";
import { modelById } from "../../../../src/domains/agents/models";
import { geminiFetch } from "./gemini-openai";
import { providerErrorGuardFetch } from "./provider-error-guard";

/*
 * A catalog model as the agent calls it: the catalog (src/domains/agents/
 * models.ts) owns ids, base URLs and key env names.
 *
 * Credentials resolve at call time, not at module load. The deployed Eve
 * service bundles this module, and on Vercel the bundle's module-scope env
 * reads did not see the deployment's env (runs failed with an invalid key while
 * the vars were set). `catalogModel` is called per step, so the key it reads is
 * current; `lazyCatalogModel` is for the one model built at module load (the
 * compaction model) and reads the key on every request instead.
 */

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A provider chat model: an object eve can wrap and call per step. */
type ChatModel = ReturnType<ReturnType<typeof createOpenAI>["chat"]>;

function entryOrThrow(id: string) {
  // A frozen id that left the catalog (a probe-retired entry) must fail the
  // run loudly: falling back to the default would record one model on the run
  // row while another answered — the lie the spend contract forbids.
  const entry = modelById(id);
  if (!entry) {
    throw new Error(
      `Model "${id}" is not in the catalog. Choose another model; the run's frozen model is never silently substituted.`,
    );
  }
  return entry;
}

function missingKey(keyEnv: string, label: string): Error {
  // The message names the restart case explicitly. A dev server inherits its
  // environment at boot, so a key added to .env while eve is already running
  // is invisible here and reads exactly like a missing key.
  return new Error(
    `${keyEnv} is not set, so ${label} cannot run. Set ${keyEnv} and restart the agent process (a dev server only sees .env as it was at boot), or choose another model.`,
  );
}

function build(id: string, apiKey: string, fetchImpl: Fetcher): ChatModel {
  const entry = entryOrThrow(id);
  const guarded = providerErrorGuardFetch(fetchImpl);
  const provider = createOpenAI({
    apiKey,
    baseURL: entry.baseUrl,
    name: entry.provider,
    fetch: entry.provider === "gemini" ? geminiFetch(guarded) : guarded,
  });
  const model = provider.chat(entry.id);
  // OpenRouter's credit check reserves the full max_tokens amount. Its catalog
  // maximum (16k) exceeded the remaining credit in a real chat and caused a
  // silent-looking turn failure; cap the request while retaining streaming.
  return entry.provider === "openrouter-free" ? withMaxOutputTokens(model, 12_000) : model;
}

/** The model for one step. A model whose key vanished fails rather than quietly running another provider. */
export function catalogModel(id: string): ChatModel {
  const entry = entryOrThrow(id);
  const apiKey = (process.env[entry.keyEnv] ?? "").trim();
  if (!apiKey) throw missingKey(entry.keyEnv, entry.label);
  return build(id, apiKey, fetch);
}

/** A model built once at module load whose key is read on every request. */
export function lazyCatalogModel(id: string): ChatModel {
  const entry = entryOrThrow(id);
  const withKey: Fetcher = (input, init) => {
    const apiKey = (process.env[entry.keyEnv] ?? "").trim();
    if (!apiKey) return Promise.reject(missingKey(entry.keyEnv, entry.label));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${apiKey}`);
    return fetch(input, { ...init, headers });
  };
  // The placeholder never leaves the process: `withKey` replaces the header.
  return build(id, "resolved-per-request", withKey);
}
