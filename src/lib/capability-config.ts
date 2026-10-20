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
 * `requiredEnv` is the list, `missingEnv` is what the operator must set, and
 * `reason` is the sentence a person reads. A capability with no required
 * variables is always configured.
 */

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
  /** True when any one of these being set is enough. */
  anyOf: readonly string[];
  /** Understood as "unavailable" even when configured — e.g. a refusing port. */
  subject: string;
  /** Named after the reason so the operator knows what to set. */
  action: string;
};

/*
 * Order matters only for display. Each entry mirrors the selection logic in the
 * adapter it describes — when that logic changes, this list changes with it, and
 * a unit test asserts the two agree for the env vars each one reads.
 */
const DEFINITIONS: readonly Definition[] = [
  {
    id: "document-extraction-hosted",
    label: "Hosted document extraction",
    anyOf: ["DOCLING_SERVE_URL", "REDUCTO_API_KEY", "LLAMAPARSE_API_KEY"],
    subject: "Scanned documents and images cannot be read",
    action: "set DOCLING_SERVE_URL, REDUCTO_API_KEY or LLAMAPARSE_API_KEY",
  },
  {
    id: "web-search-keyed",
    label: "Keyed web search",
    anyOf: ["SEARCH_PROVIDER", "SEARXNG_URL", "FIRECRAWL_HOSTED_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY"],
    subject: "Search falls back to the zero-key DuckDuckGo endpoint",
    action: "set SEARCH_PROVIDER, or a provider key, to use a different provider",
  },
  {
    id: "generation",
    label: "Model generation",
    anyOf: ["OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    subject: "Drafting and classification that call a model are unavailable",
    action: "set OPENROUTER_API_KEY or GEMINI_API_KEY",
  },
  {
    id: "embeddings",
    label: "Document embeddings",
    anyOf: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
    subject: "Semantic search is unavailable",
    action: "set OPENROUTER_API_KEY or OPENAI_API_KEY",
  },
  {
    id: "agent-execution",
    label: "Agent execution",
    anyOf: ["EVE_BASE_URL", "EVE_BRIDGE_SECRET"],
    subject: "Runs cannot start",
    action: "set EVE_BASE_URL and EVE_BRIDGE_SECRET (32 or more characters, the same on the app and the agent)",
  },
  {
    id: "calendar-sync",
    label: "Calendar sync",
    anyOf: ["COMPOSIO_API_KEY"],
    subject: "Calendar events cannot be read",
    action: "set COMPOSIO_API_KEY",
  },
  {
    id: "email-send",
    label: "Email sending",
    anyOf: ["COMPOSIO_API_KEY"],
    subject: "Approved messages cannot leave the workspace",
    action: "wire a MailSender adapter and set COMPOSIO_API_KEY",
  },
  {
    id: "private-file-storage",
    label: "Private file storage",
    anyOf: ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"],
    subject: "Uploaded originals cannot be stored",
    action: "set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with Vercel OIDC",
  },
];

function isSet(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

export function capabilityStatus(
  env: Record<string, string | undefined> = process.env,
): CapabilityStatus[] {
  return DEFINITIONS.map((definition) => {
    const missingEnv = definition.anyOf.filter((key) => !isSet(env, key));
    // "Any one set is enough" means it is configured once at least one is present.
    const configured = missingEnv.length < definition.anyOf.length;
    return {
      id: definition.id,
      label: definition.label,
      configured,
      requiredEnv: definition.anyOf,
      missingEnv: configured ? [] : missingEnv,
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
