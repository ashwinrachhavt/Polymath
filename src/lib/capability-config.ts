/*
 * Every capability that is switched on by an environment variable, named in one
 * place. A missing key used to be indistinguishable from "the answer is none":
 * the page rendered, the list was empty, and nothing said why (ASH-193).
 *
 * This module is the single source for that answer. It is pure — it reads a
 * passed env object, never `process.env` at import — so a test can assert the
 * unset case without touching the real environment, and the settings surface can
 * render it server-side without importing a provider client.
 *
 * Each entry models the resolver it describes, not a generic "any key is set"
 * rule. That distinction is the whole point: `SEARCH_PROVIDER=firecrawl` with no
 * firecrawl key throws at request time, and `EVE_BASE_URL` without a 32-character
 * bridge secret starts no run. A panel that says "ready" in those states is
 * worse than no panel, because it turns a configuration bug into a mystery.
 */

/** Mirrors MIN_SECRET_LENGTH in src/domains/agents/bridge-token.ts. */
const BRIDGE_SECRET_MIN_LENGTH = 32;

export type CapabilityId =
  | "document-extraction-hosted"
  | "web-search-keyed"
  | "generation"
  | "embeddings"
  | "agent-execution"
  | "calendar-sync"
  | "email-send"
  | "private-file-storage";

export type CapabilityStatus = {
  id: CapabilityId;
  /** What the person calls it. Sentence case, no jargon. */
  label: string;
  /** Safe to show: names variables, never their values. */
  configured: boolean;
  /** Variables that must be set. Never includes values. */
  requiredEnv: readonly string[];
  /** Which of them are unset right now. */
  missingEnv: string[];
  /** One sentence naming what is unavailable and what turns it on. */
  reason: string;
};

type Definition = {
  id: CapabilityId;
  label: string;
  /** The variables this capability reads, for display when it is off. */
  watches: readonly string[];
  /** Mirrors the adapter's own selection logic. True means it will work now. */
  ready: (env: Record<string, string | undefined>) => boolean;
  /** Which watched variables are unset, for the operator's next step. */
  missing: (env: Record<string, string | undefined>) => string[];
  /** What a person cannot do, and what turns it on. */
  subject: string;
  action: string;
};

function set(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const has = (env: Record<string, string | undefined>, key: string) => set(env, key) !== null;

/*
 * The selector, when set, decides the adapter outright — so only the variables
 * that selector needs can make it ready. Without a selector the adapter falls
 * back to the first configured key, which is the "any of" case.
 */
function selectorResolution(
  env: Record<string, string | undefined>,
  selectorKey: string,
  perChoice: Record<string, readonly string[]>,
  fallback: readonly string[],
): { ready: boolean; missing: string[] } {
  const selector = set(env, selectorKey)?.toLowerCase();
  if (selector) {
    const needed = perChoice[selector];
    // An unknown selector makes the resolver throw; it is never ready.
    if (!needed) return { ready: false, missing: [`${selectorKey}=${selector} is not a known choice`] };
    const missing = needed.filter((key) => !has(env, key));
    return { ready: missing.length === 0, missing };
  }
  const missing = fallback.filter((key) => !has(env, key));
  // Without a selector, any one configured key is enough.
  return { ready: missing.length < fallback.length, missing: missing.length < fallback.length ? [] : [...fallback] };
}

const SEARCH_CHOICES: Record<string, readonly string[]> = {
  firecrawl: ["FIRECRAWL_HOSTED_API_KEY"],
  searxng: ["SEARXNG_URL"],
  brave: ["BRAVE_SEARCH_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  exa: ["EXA_API_KEY"],
  duckduckgo: [],
};
const SEARCH_FALLBACK: readonly string[] = [
  "SEARXNG_URL",
  "FIRECRAWL_HOSTED_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
];
const search = (env: Record<string, string | undefined>) =>
  selectorResolution(env, "SEARCH_PROVIDER", SEARCH_CHOICES, SEARCH_FALLBACK);

const GENERATION_CHOICES: Record<string, readonly string[]> = {
  gemini: ["GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};
const generation = (env: Record<string, string | undefined>) =>
  selectorResolution(env, "GENERATION_PROVIDER", GENERATION_CHOICES, ["OPENROUTER_API_KEY", "GEMINI_API_KEY"]);

const EMBEDDING_CHOICES: Record<string, readonly string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};
const embeddings = (env: Record<string, string | undefined>) =>
  selectorResolution(env, "EMBEDDING_PROVIDER", EMBEDDING_CHOICES, ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]);

const DEFINITIONS: readonly Definition[] = [
  {
    id: "document-extraction-hosted",
    label: "Hosted document extraction",
    watches: ["DOCLING_SERVE_URL", "REDUCTO_API_KEY", "LLAMAPARSE_API_KEY", "OCR_PROVIDER", "OCR_MODEL"],
    // Mirrors extractionProvider() plus the vision-OCR rescue in
    // extractDocument(): a hosted reader is configured by any one of the three
    // provider keys, or by the explicit OCR_PROVIDER=openrouter opt-in with the
    // workspace's OpenRouter key. An OpenRouter key alone does NOT count — the
    // metered route is opt-in, never inferred. With none, the in-process
    // text-layer reader still handles text PDFs, so this entry is about scans
    // and images, not about reading working at all.
    ready: (env) =>
      has(env, "DOCLING_SERVE_URL") ||
      has(env, "REDUCTO_API_KEY") ||
      has(env, "LLAMAPARSE_API_KEY") ||
      (set(env, "OCR_PROVIDER")?.toLowerCase() === "openrouter" && has(env, "OPENROUTER_API_KEY")),
    missing: (env) => {
      if (
        has(env, "DOCLING_SERVE_URL") ||
        has(env, "REDUCTO_API_KEY") ||
        has(env, "LLAMAPARSE_API_KEY") ||
        (set(env, "OCR_PROVIDER")?.toLowerCase() === "openrouter" && has(env, "OPENROUTER_API_KEY"))
      ) {
        return [];
      }
      // The opt-in was set but its key is missing: name the key, not the menu.
      if (set(env, "OCR_PROVIDER")?.toLowerCase() === "openrouter") return ["OPENROUTER_API_KEY"];
      return ["DOCLING_SERVE_URL", "REDUCTO_API_KEY", "LLAMAPARSE_API_KEY", "OCR_PROVIDER=openrouter (uses OPENROUTER_API_KEY)"];
    },
    subject: "Scanned PDFs and images cannot be read; text-layer PDFs still can",
    action:
      "set DOCLING_SERVE_URL, REDUCTO_API_KEY or LLAMAPARSE_API_KEY, or OCR_PROVIDER=openrouter to read scans through the workspace's OpenRouter key (metered per page; OCR_MODEL picks the model)",
  },
  {
    id: "web-search-keyed",
    label: "Keyed web search",
    watches: ["SEARCH_PROVIDER", ...SEARCH_FALLBACK],
    // Mirrors webSearchProvider(). DuckDuckGo needs no key, so search itself works
    // unconfigured; this entry reports whether a keyed provider is in use, which is
    // what quota accounting depends on.
    ready: (env) => search(env).ready,
    missing: (env) => search(env).missing,
    subject: "Search falls back to the zero-key DuckDuckGo endpoint, which has no SLA and no quota accounting",
    action: "set SEARCH_PROVIDER with its matching key, or any one provider key",
  },
  {
    id: "generation",
    label: "Model generation",
    watches: ["GENERATION_PROVIDER", "OPENROUTER_API_KEY", "GEMINI_API_KEY"],
    // Mirrors generationProvider(): the selector wins outright; the fallback
    // prefers the paid OpenRouter key, then the free Gemini key.
    ready: (env) => generation(env).ready,
    missing: (env) => generation(env).missing,
    subject: "Drafting and classification that call a model are unavailable",
    action: "set OPENROUTER_API_KEY or GEMINI_API_KEY",
  },
  {
    id: "embeddings",
    label: "Document embeddings",
    watches: ["EMBEDDING_PROVIDER", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
    // Mirrors embeddingProvider(): the selector wins; otherwise OpenRouter then OpenAI.
    ready: (env) => embeddings(env).ready,
    missing: (env) => embeddings(env).missing,
    subject: "Semantic search is unavailable",
    action: "set OPENROUTER_API_KEY or OPENAI_API_KEY",
  },
  {
    id: "agent-execution",
    label: "Agent execution",
    watches: ["EVE_BRIDGE_SECRET", "EVE_BASE_URL"],
    // Mirrors bridgeSecret(): the secret is required AND must be long enough.
    // EVE_BASE_URL is a routing hint, not a credential — a deployment reaches
    // its own origin without it, so its absence alone never blocks a run.
    ready: (env) => (set(env, "EVE_BRIDGE_SECRET")?.length ?? 0) >= BRIDGE_SECRET_MIN_LENGTH,
    missing: (env) => {
      const secret = set(env, "EVE_BRIDGE_SECRET");
      if (!secret) return ["EVE_BRIDGE_SECRET", "EVE_BASE_URL"];
      if (secret.length < BRIDGE_SECRET_MIN_LENGTH) return ["EVE_BRIDGE_SECRET (at least 32 characters)"];
      return [];
    },
    subject: "Runs cannot start",
    action:
      "set EVE_BRIDGE_SECRET to 32 or more characters, and EVE_BASE_URL when the agent runs on another host",
  },
  {
    id: "calendar-sync",
    label: "Calendar sync",
    watches: ["COMPOSIO_API_KEY"],
    ready: (env) => has(env, "COMPOSIO_API_KEY"),
    missing: (env) => (has(env, "COMPOSIO_API_KEY") ? [] : ["COMPOSIO_API_KEY"]),
    subject: "Calendar events cannot be read",
    action: "set COMPOSIO_API_KEY and connect a calendar account",
  },
  {
    id: "email-send",
    label: "Email sending",
    watches: ["COMPOSIO_API_KEY"],
    // There is no MailSender implementation in the codebase — only the refusing
    // default port. No environment variable makes this work, so reporting it
    // ready on a Composio key would be the exact lie this module exists to stop.
    ready: () => false,
    missing: () => [],
    subject: "Approved messages cannot leave the workspace; the send adapter is not implemented",
    action: "ship a MailSender adapter, then wire it to the connected account",
  },
  {
    id: "private-file-storage",
    label: "Private file storage",
    watches: ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"],
    // Mirrors objectStoreMode(): cloud storage needs a credential, but a
    // development build stores to local disk and works. Production without a
    // key is the state this entry is for.
    ready: (env) =>
      has(env, "BLOB_READ_WRITE_TOKEN") || has(env, "BLOB_STORE_ID") || env.NODE_ENV !== "production",
    missing: (env) =>
      has(env, "BLOB_READ_WRITE_TOKEN") || has(env, "BLOB_STORE_ID") || env.NODE_ENV !== "production"
        ? []
        : ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"],
    subject: "Uploaded originals cannot be stored",
    action: "set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with Vercel OIDC",
  },
];

export function capabilityStatus(
  env: Record<string, string | undefined> = process.env,
): CapabilityStatus[] {
  return DEFINITIONS.map((definition) => {
    const configured = definition.ready(env);
    const missingEnv = configured ? [] : definition.missing(env);
    return {
      id: definition.id,
      label: definition.label,
      configured,
      requiredEnv: definition.watches,
      missingEnv,
      reason: configured ? "" : `${definition.subject}. To turn it on, ${definition.action}.`,
    };
  });
}

/** The configured ones, and the ones still missing — the shape a settings panel renders. */
export function capabilitySummary(env: Record<string, string | undefined> = process.env): {
  configured: CapabilityStatus[];
  missing: CapabilityStatus[];
} {
  const all = capabilityStatus(env);
  return { configured: all.filter((c) => c.configured), missing: all.filter((c) => !c.configured) };
}
