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
 *
 * A choice's value lists alternatives, and an alternative's keys are ALL
 * required: `[[A, B], [C]]` means "A and B together, or C alone". A provider
 * reachable under two names (Mercury answers to MERCURY_API_KEY or
 * INCEPTION_API_KEY) must not read as missing one of them.
 */
type Alternatives = readonly (readonly string[])[];

function selectorResolution(
  env: Record<string, string | undefined>,
  selectorKey: string,
  perChoice: Record<string, Alternatives>,
  fallback: Alternatives,
  /** The names the "set one of these" message uses, when it differs from the alternatives. */
  fallbackLabels?: readonly string[],
): { ready: boolean; missing: string[] } {
  const selector = set(env, selectorKey)?.toLowerCase();
  const missingOf = (alternative: readonly string[]) => alternative.filter((key) => !has(env, key));
  if (selector) {
    const alternatives = perChoice[selector];
    // An unknown selector makes the resolver throw; it is never ready.
    if (!alternatives) return { ready: false, missing: [`${selectorKey}=${selector} is not a known choice`] };
    const tried = alternatives.map(missingOf);
    const closest = tried.find((missing) => missing.length === 0);
    if (closest) return { ready: true, missing: [] };
    // Name the alternative the account is closest to satisfying.
    const nearest = tried.reduce((best, current) => (current.length < best.length ? current : best));
    return { ready: false, missing: nearest };
  }
  if (fallback.some((alternative) => missingOf(alternative).length === 0)) return { ready: true, missing: [] };
  const labels = fallbackLabels ?? fallback.flatMap((alternative) => alternative);
  return { ready: false, missing: [...labels] };
}

const SEARCH_CHOICES: Record<string, Alternatives> = {
  firecrawl: [["FIRECRAWL_HOSTED_API_KEY"]],
  searxng: [["SEARXNG_URL"]],
  brave: [["BRAVE_SEARCH_API_KEY"]],
  tavily: [["TAVILY_API_KEY"]],
  exa: [["EXA_API_KEY"]],
  parallel: [["PARALLEL_API_KEY"]],
  "ai-gateway-exa": [["AI_GATEWAY_API_KEY"]],
  "ai-gateway-tako": [["AI_GATEWAY_API_KEY"]],
  "ai-gateway-parallel": [["AI_GATEWAY_API_KEY"]],
  "ai-gateway-perplexity": [["AI_GATEWAY_API_KEY"]],
  duckduckgo: [],
};
// Mirrors webSearchProvider()'s auto-chain restricted to what the provider
// registry has enabled: a key whose registry entry is disabled (brave,
// tavily, exa, parallel — card-backed or unverified) does not make search
// ready, because the call would fail closed at the gate.
const SEARCH_FALLBACK: Alternatives = [["SEARXNG_URL"], ["FIRECRAWL_HOSTED_API_KEY"]];
const search = (env: Record<string, string | undefined>) =>
  selectorResolution(env, "SEARCH_PROVIDER", SEARCH_CHOICES, SEARCH_FALLBACK);

const GENERATION_CHOICES: Record<string, Alternatives> = {
  gemini: [["GEMINI_API_KEY"]],
  // Either credential serves Mercury; one alone is enough.
  mercury: [["MERCURY_API_KEY"], ["INCEPTION_API_KEY"]],
  openrouter: [["OPENROUTER_API_KEY"]],
};
const generation = (env: Record<string, string | undefined>) =>
  selectorResolution(env, "GENERATION_PROVIDER", GENERATION_CHOICES, [
    ["MERCURY_API_KEY"],
    ["INCEPTION_API_KEY"],
    ["GEMINI_API_KEY"],
    ["OPENROUTER_API_KEY"],
  ]);

const EMBEDDING_CHOICES: Record<string, Alternatives> = {
  openrouter: [["OPENROUTER_API_KEY"]],
  openai: [["OPENAI_API_KEY"]],
};
const embeddings = (env: Record<string, string | undefined>) =>
  selectorResolution(env, "EMBEDDING_PROVIDER", EMBEDDING_CHOICES, [["OPENROUTER_API_KEY"], ["OPENAI_API_KEY"]]);

const DEFINITIONS: readonly Definition[] = [
  {
    id: "document-extraction-hosted",
    label: "Hosted document extraction",
    watches: [
      "DOCLING_SERVE_URL",
      "REDUCTO_API_KEY",
      "LLAMAPARSE_API_KEY",
      "OCR_PROVIDER",
      "OCR_MODEL",
      "OCR_ALLOW_UNVERIFIED_UPSTREAM",
    ],
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
      return [
        "DOCLING_SERVE_URL",
        "REDUCTO_API_KEY",
        "LLAMAPARSE_API_KEY",
        "OCR_PROVIDER=openrouter (uses OPENROUTER_API_KEY)",
      ];
    },
    subject: "Scanned PDFs and images cannot be read; text-layer PDFs still can",
    action:
      "set DOCLING_SERVE_URL, REDUCTO_API_KEY or LLAMAPARSE_API_KEY, or OCR_PROVIDER=openrouter to read scans through the workspace's OpenRouter key (metered by model input/output tokens; OCR_MAX_PAGES caps pages per extraction; OCR_MODEL picks the model)",
  },
  {
    id: "web-search-keyed",
    label: "Keyed web search",
    watches: ["SEARCH_PROVIDER", ...SEARCH_FALLBACK.flatMap((alternative) => alternative)],
    // Mirrors webSearchProvider(). DuckDuckGo needs no key, so search itself works
    // unconfigured; this entry reports whether a keyed provider is in use, which is
    // what quota accounting depends on.
    ready: (env) => search(env).ready,
    missing: (env) => search(env).missing,
    subject: "Search falls back to the zero-key DuckDuckGo endpoint, which has no SLA and no quota accounting",
    action: "set SEARCH_PROVIDER with its matching key, or a key the registry enables (SearXNG or Firecrawl)",
  },
  {
    id: "generation",
    label: "Model generation",
    // Mercury answers to either credential; INCEPTION_API_KEY is the same
    // provider under its vendor name.
    watches: ["GENERATION_PROVIDER", "MERCURY_API_KEY", "INCEPTION_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"],
    // Mirrors generationProvider(): the selector wins outright; the fallback
    // prefers the Mercury trial grant, then the free Gemini key, then the paid
    // OpenRouter key.
    ready: (env) => generation(env).ready,
    missing: (env) => generation(env).missing,
    subject: "Drafting and classification that call a model are unavailable",
    action: "set MERCURY_API_KEY (or INCEPTION_API_KEY), GEMINI_API_KEY or OPENROUTER_API_KEY",
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
    action: "set EVE_BRIDGE_SECRET to 32 or more characters, and EVE_BASE_URL when the agent runs on another host",
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
    // Mirrors gmailMailSender(): the adapter refuses before dispatch without
    // the Composio project key. The connected Gmail account is workspace data
    // the send executor checks per send, not env, so "ready" here means the
    // deployment can send for a workspace that has one connected.
    ready: (env) => has(env, "COMPOSIO_API_KEY"),
    missing: (env) => (has(env, "COMPOSIO_API_KEY") ? [] : ["COMPOSIO_API_KEY"]),
    subject: "Approved messages cannot leave the workspace",
    action: "set COMPOSIO_API_KEY and connect a Gmail account",
  },
  {
    id: "private-file-storage",
    label: "Private file storage",
    watches: ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"],
    // Mirrors objectStoreMode(): cloud storage needs a credential, but a
    // development build stores to local disk and works. Production without a
    // key is the state this entry is for.
    ready: (env) => has(env, "BLOB_READ_WRITE_TOKEN") || has(env, "BLOB_STORE_ID") || env.NODE_ENV !== "production",
    missing: (env) =>
      has(env, "BLOB_READ_WRITE_TOKEN") || has(env, "BLOB_STORE_ID") || env.NODE_ENV !== "production"
        ? []
        : ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"],
    subject: "Uploaded originals cannot be stored",
    action: "set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with Vercel OIDC",
  },
];

export function capabilityStatus(env: Record<string, string | undefined> = process.env): CapabilityStatus[] {
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
