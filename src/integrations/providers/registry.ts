/*
 * The provider registry: one record per external provider Polymath can spend
 * against, with the entitlement facts that decide whether an agent route may
 * use it. The free-first rule (ASH-187): agents request capabilities through
 * the registry and quota ledger — they never receive raw provider keys, and
 * no route falls back to paid usage because a free allowance ran out.
 *
 * Every allowance claim here was verified against the provider's own pricing
 * or documentation page on `verifiedAt`; the URL is in `verificationSource`.
 * A provider whose current free terms could not be verified is registered
 * with freeClass "unverified" and enabled: false — it fails closed until
 * someone re-checks the official source and flips it with evidence.
 *
 * Allowances are defaults from the provider's public page; an account's real
 * entitlement can differ (billing cycle anchors, tier-specific rate limits),
 * so each quota carries an env override (`allowanceEnv`) that wins without a
 * code change.
 */

export type Capability = "generate" | "classify" | "search" | "read" | "retrieve" | "action";

export type FreeClass =
  /** Allowance renews daily or monthly without a payment card. */
  | "recurring"
  /** Recurring credit, but a payment card is on file and overage can bill. */
  | "card-backed"
  /** Credit expires or is consumed once; never baseline capacity. */
  | "trial"
  /** Software is free; hardware and operations are ours. */
  | "self-hosted"
  /** Current entitlement not established. Disabled until checked. */
  | "unverified"
  /** Paid usage the workspace already runs on its own key (status quo). */
  | "paid";

export type QuotaUnit = "credits" | "requests" | "tokens" | "neurons";

export type ProviderQuota = {
  unit: QuotaUnit;
  /** Default allowance per renewal period, from the provider's public page. */
  allowance: number;
  /** How often the allowance resets. */
  renewal: "daily" | "monthly";
  /** Env var that overrides `allowance` when the account's real number differs. */
  allowanceEnv?: string;
};

export type ProviderEntry = {
  /** Matches the adapter's reported name where one exists (e.g. "firecrawl"). */
  id: string;
  capability: Capability;
  freeClass: FreeClass;
  enabled: boolean;
  /** Paid usage on this route is allowed at all. Free-first default: false. */
  allowPaidUsage: boolean;
  /** Falling back to a paid route when the free allowance runs out. Always false. */
  allowPaidFallback: boolean;
  /** Sensitive workspace content may be sent. False when free-tier data may train. */
  sensitiveDataAllowed: boolean;
  quota: ProviderQuota | null;
  /** ISO date the entitlement was last checked against the official source. */
  verifiedAt: string | null;
  /** The official pricing/docs URL the claim was verified against. */
  verificationSource: string | null;
  notes?: string;
};

export class ProviderDisabledError extends Error {
  constructor(id: string, reason: string) {
    super(`Provider "${id}" is not usable: ${reason}`);
    this.name = "ProviderDisabledError";
  }
}

const CHECKED = "2026-10-19";

const REGISTRY: readonly ProviderEntry[] = [
  {
    id: "firecrawl",
    capability: "search",
    freeClass: "recurring",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: {
      unit: "credits",
      allowance: 1000,
      renewal: "monthly",
      allowanceEnv: "FIRECRAWL_MONTHLY_CREDITS",
    },
    verifiedAt: CHECKED,
    verificationSource: "https://www.firecrawl.dev/pricing",
    notes:
      "Hosted free tier: 1,000 credits/month, no card. Search costs 2 credits per 10 results; " +
      "scrape/crawl 1 credit per page. Search and scrape share one balance. Periods are UTC " +
      "calendar months; the account's exact billing-cycle anchor may differ.",
  },
  {
    id: "gemini",
    capability: "generate",
    freeClass: "recurring",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    // Free-tier prompts/responses may be used to improve Google products.
    sensitiveDataAllowed: false,
    quota: {
      unit: "requests",
      // Conservative default: the free tier's per-model RPD is account- and
      // model-specific (check AI Studio). Override with GEMINI_DAILY_REQUESTS.
      allowance: 100,
      renewal: "daily",
      allowanceEnv: "GEMINI_DAILY_REQUESTS",
    },
    verifiedAt: CHECKED,
    verificationSource: "https://ai.google.dev/gemini-api/docs/pricing",
    notes:
      "Free-of-charge input/output confirmed for gemini-3.5-flash-lite and gemini-3.8-flash. " +
      "Google Search/Maps grounding is NOT available on the free tier — 'free Gemini' is not " +
      "free web research. Daily quotas reset at midnight Pacific; the ledger period follows.",
  },
  {
    id: "duckduckgo",
    capability: "search",
    freeClass: "recurring",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: null,
    verificationSource: null,
    notes: "Zero-key HTML endpoint, no SLA and no published allowance. No quota to spend against.",
  },
  {
    id: "searxng",
    capability: "search",
    freeClass: "self-hosted",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: null,
    verificationSource: null,
    notes: "Local compose instance (`make search-up`). Costs are our own hardware, not a vendor allowance.",
  },
  {
    id: "firecrawl-selfhosted",
    capability: "read",
    freeClass: "self-hosted",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: null,
    verificationSource: null,
    notes: "Local compose scrape/crawl transport (src/integrations/firecrawl/client.ts). No vendor credits consumed.",
  },
  {
    id: "brave",
    capability: "search",
    freeClass: "card-backed",
    // Owner decision 2026-10-27: the card is accepted and the key is live, so
    // this becomes usable. Overage still bills — the ledger, not this flag, is
    // what stops spend.
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: { unit: "requests", allowance: 2000, renewal: "monthly", allowanceEnv: "BRAVE_MONTHLY_REQUESTS" },
    verifiedAt: CHECKED,
    verificationSource: "https://brave.com/search/api/",
    notes:
      "Card required; prepaid credits; $5 per 1,000 requests confirmed on the official page. " +
      "The monthly free allowance could not be re-verified (dashboard pricing is account-gated), " +
      "so the route stays disabled until the account dashboard confirms it.",
  },
  {
    id: "tavily",
    capability: "search",
    freeClass: "unverified",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: null,
    verificationSource: null,
    notes: "Existing keyed adapter. Current free entitlement not verified; confirm renewal and endpoint costs before enabling.",
  },
  {
    id: "exa",
    capability: "search",
    freeClass: "unverified",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: null,
    verificationSource: null,
    notes: "Existing keyed adapter. Signup credit may be one-time; confirm before enabling.",
  },
  {
    id: "parallel",
    capability: "search",
    freeClass: "card-backed",
    // Owner decision 2026-10-27: explicit opt-in, card consent given. It stays
    // OUT of the automatic selection chain in search/provider.ts — reaching it
    // takes SEARCH_PROVIDER=parallel, so it can never bill by surprise.
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: { unit: "requests", allowance: 5000, renewal: "monthly", allowanceEnv: "PARALLEL_MONTHLY_REQUESTS" },
    verifiedAt: CHECKED,
    verificationSource: "https://parallel.ai/pricing",
    notes:
      "Up to 5,000 free requests/month confirmed, but the eligible organization needs a payment " +
      "card and excess usage bills. Opt-in only, with the card consent explicit.",
  },
  {
    id: "ai-gateway-search",
    capability: "search",
    freeClass: "paid",
    enabled: false,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: CHECKED,
    verificationSource: "https://vercel.com/docs/ai-gateway/models-and-providers/web-search",
    notes:
      "AI Gateway server tools (Exa, Tako, Parallel, Perplexity) billed per 1k requests. " +
      "The 2026 free promos expired; enable only with an explicit spend decision.",
  },
  {
    id: "jina-reader",
    capability: "read",
    freeClass: "recurring",
    enabled: false,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: CHECKED,
    verificationSource: "https://jina.ai/reader/",
    notes:
      "No-key Reader at 20 RPM confirmed (500 RPM with a free key). The free key's token grant is " +
      "one-time, not recurring. No adapter yet; candidate for known-URL reading.",
  },
  {
    id: "composio",
    capability: "action",
    freeClass: "recurring",
    enabled: true,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: false,
    quota: { unit: "requests", allowance: 100000, renewal: "monthly", allowanceEnv: "COMPOSIO_MONTHLY_TOOL_CALLS" },
    verifiedAt: "2026-10-25",
    verificationSource: "https://composio.dev/pricing",
    notes:
      "Hobby: 100k tool calls/mo free (Composio-managed apps are a <=20k subset), 50k triggers, " +
      "1M sandbox LLM tokens, no card — re-verified 2026-10-25 against the pricing page and " +
      "pricing.md, which agree. Execution modes have separate allowances; Instant Tools bill the " +
      "provider's own charges from the Composio balance, separate from plan allowances, and " +
      "Composio enforces no org-balance limit — spend protection is ours. Not ledger-gated yet — " +
      "per-mode unit accounting lands with the actions work.",
  },
  {
    id: "openrouter",
    capability: "generate",
    freeClass: "paid",
    enabled: true,
    // The existing workspace-funded route; not a fallback — selected by env only.
    allowPaidUsage: true,
    allowPaidFallback: false,
    sensitiveDataAllowed: true,
    quota: null,
    verifiedAt: null,
    verificationSource: null,
    notes: "Status-quo generation path on the workspace's own key. Never auto-selected as a rescue route.",
  },
  {
    id: "cloudflare-workers-ai",
    capability: "generate",
    freeClass: "recurring",
    enabled: false,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: false,
    quota: { unit: "neurons", allowance: 10000, renewal: "daily" },
    verifiedAt: CHECKED,
    verificationSource: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    notes: "10,000 neurons/day free confirmed (resets 00:00 UTC). Neurons are not tokens. No adapter yet.",
  },
  {
    id: "cerebras",
    capability: "generate",
    freeClass: "trial",
    enabled: false,
    allowPaidUsage: false,
    allowPaidFallback: false,
    sensitiveDataAllowed: false,
    quota: null,
    verifiedAt: CHECKED,
    verificationSource: "https://www.cerebras.ai/",
    notes: "$5 trial credit with a verified payment method, expiring after 30 days; no recurring free tier. Evaluation only.",
  },
  {
    id: "jev",
    capability: "classify",
    freeClass: "unverified",
    enabled: true,
    allowPaidUsage: true,
    allowPaidFallback: false,
    sensitiveDataAllowed: false,
    quota: null,
    verifiedAt: CHECKED,
    verificationSource: "https://docs.typesafe.ai/models",
    notes:
      "The product is real and the docs match (jev-1.14.0/jev-1.13.0, $0.042/M input tokens, free " +
      "output tokens, 64k request / 32k question context). Enabled 2026-10-25 on the owner's explicit " +
      "decision now that TYPESAFE_API_KEY is in place. No recurring free allowance exists, so spend is " +
      "bounded by JEV_MONTHLY_INPUT_TOKENS in the quota ledger, not by this entry: an unset or zero " +
      "allowance still hard-stops before any call. Only the uncertain cases pay — the rules classifier " +
      "decides first, and Jev runs on documents and captures the rules could not settle.",
  },
];

export function providerEntry(id: string): ProviderEntry | null {
  return REGISTRY.find((p) => p.id === id) ?? null;
}

export function providerRegistry(): readonly ProviderEntry[] {
  return REGISTRY;
}

/** The allowance for a quota, with the entry's env override winning when set and sane. */
export function quotaAllowance(entry: ProviderEntry, env: Record<string, string | undefined> = process.env): number | null {
  if (!entry.quota) return null;
  const override = entry.quota.allowanceEnv ? Number(env[entry.quota.allowanceEnv]) : NaN;
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : entry.quota.allowance;
}

/*
 * Fail closed. A route may use a provider only when the entry exists, is
 * enabled, and — when the caller plans to spend against a metered allowance —
 * has a quota to reserve from. "Unverified" is a verdict, not a shrug.
 */
export function assertProviderUsable(entry: ProviderEntry | null, context: string): ProviderEntry {
  if (!entry) throw new ProviderDisabledError(context, "no registry entry");
  if (!entry.enabled) {
    throw new ProviderDisabledError(entry.id, `disabled (freeClass: ${entry.freeClass})`);
  }
  if (entry.freeClass === "unverified") {
    throw new ProviderDisabledError(entry.id, "entitlement unverified");
  }
  return entry;
}
