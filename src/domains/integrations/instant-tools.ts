import { notInArray } from "drizzle-orm";
import catalogJson from "./instant-catalog.generated.json";
import { integrationCatalog } from "./schema";
import { db } from "@/lib/db";
import { drizzleQuotaStore, withQuota, type QuotaStore } from "@/integrations/providers/quota";
import { providerEntry } from "@/integrations/providers/registry";

/*
 * Composio Instant toolkits (spec #316). Instant tools execute without a
 * connected account — Composio resolves no-auth tools itself and bills the
 * call to the organization's balance. Composio enforces no spend limit, so
 * every gate here exists to keep that balance ours to predict:
 *   registry gate (D3 hard gate) → no_auth re-check at call time →
 *   deny-by-default write classification (D5) → withQuota reservation.
 *
 * Everything Instant lives in this one module (decision D2): the public
 * surface is a single contract object so a later internal split (catalog,
 * cache, execution) never changes a caller.
 *
 * The only module that talks to Composio's Instant execute endpoint. The
 * connected-account proxy stays in composio.ts; the two endpoints are
 * different contracts (execute/{slug} needs no connected_account_id, the
 * proxy requires one) and are never interchangeable.
 */

const INSTANT_EXECUTE_BASE = "https://backend.composio.dev/api/v3/tools/execute";
const TOOL_LIST_BASE = "https://backend.composio.dev/api/v3/tools";

/** Why a tool was refused before any fetch. The caller routes on this. */
export type InstantRefusalReason =
  | "registry_disabled"
  | "registry_unverified"
  | "not_no_auth"
  | "write_unverified";

export class InstantToolNotExecutableError extends Error {
  readonly code = "instant_tool_not_executable";
  constructor(readonly reason: InstantRefusalReason, toolSlug: string) {
    super(`Instant tool "${toolSlug}" is not executable (${reason}).`);
  }
}

export type InstantToolDescriptor = {
  slug: string;
  name: string;
  noAuth: boolean;
  /** "read" only when the tool's metadata proves read-only; else "unverified" (deny-by-default, D5). */
  riskClass: "read" | "unverified";
};

export type InstantCatalogJson = {
  generatedAt: string;
  toolkits: Array<{
    slug: string;
    displayName: string;
    logoUrl: string | null;
    tools: Array<{ slug: string; name: string; noAuth: boolean; riskClass: "read" | "unverified" }>;
  }>;
};

export type InstantExecuteResult =
  | { ok: true; data: unknown }
  | { ok: false; code: "not_configured" | "provider_error"; message: string; status?: number };

export type InstantCapabilityResolution = { toolkitSlug: string };

/*
 * The generated JSON is a build artifact, but it crosses a trust boundary
 * (regenerated from an external API), so it is parsed, not trusted. A shape
 * violation throws at first use instead of leaking undefined into the gates.
 */
function parseCatalogJson(value: unknown): InstantCatalogJson {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { toolkits?: unknown }).toolkits)
  ) {
    throw new Error("instant-catalog.generated.json has an unexpected shape.");
  }
  const parsed = value as InstantCatalogJson;
  for (const toolkit of parsed.toolkits) {
    if (typeof toolkit.slug !== "string" || !Array.isArray(toolkit.tools)) {
      throw new Error("instant-catalog.generated.json toolkit entry is malformed.");
    }
    for (const tool of toolkit.tools) {
      if (tool.riskClass !== "read" && tool.riskClass !== "unverified") {
        throw new Error(`instant-catalog.generated.json tool ${tool.slug} has an invalid riskClass.`);
      }
    }
  }
  return parsed;
}

let catalogJsonCache: InstantCatalogJson | null = null;

function readInstantCatalogJson(): InstantCatalogJson {
  catalogJsonCache ??= parseCatalogJson(catalogJson);
  return catalogJsonCache;
}

/**
 * The single derivation of an Instant capability name. Tests (T7) import this
 * to prove the namespace cannot collide with hand-registered capabilities.
 */
export function deriveInstantCapability(toolkitSlug: string, toolSlug: string): string {
  const suffix = toolSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `instant.${toolkitSlug}.${suffix}`;
}

/**
 * The inverse: the gateway routes any `instant.`-prefixed tool name here.
 * Unknown toolkits resolve to null so a retired toolkit falls through to the
 * gateway's 404 instead of a misleading refusal.
 */
export function resolveInstantCapability(tool: string): InstantCapabilityResolution | null {
  if (!tool.startsWith("instant.")) return null;
  const toolkitSlug = tool.split(".")[1];
  if (!toolkitSlug) return null;
  const known = readInstantCatalogJson().toolkits.some((t) => t.slug === toolkitSlug);
  return known ? { toolkitSlug } : null;
}

/*
 * Per-toolkit descriptor cache, 5-minute TTL — the same freshness the
 * auth-config discovery in composio.ts chose. On a Composio outage the stale
 * cache is served rather than thrown away: a read catalog that is minutes old
 * keeps agents working, and no_auth is still re-checked here on every execute.
 */
const LIST_TTL_MS = 5 * 60_000;
const listCache = new Map<string, { at: number; tools: InstantToolDescriptor[] }>();

/** Test seam: drop the cached descriptors so a stubbed fetch is exercised. */
export function resetInstantListCache() {
  listCache.clear();
}

/** Test seam only: seed the descriptor cache as if a fetch had succeeded. */
export function seedInstantListCacheForTest(slug: string, tools: InstantToolDescriptor[]) {
  listCache.set(slug, { at: Date.now(), tools });
}

async function fetchInstantTools(slug: string, apiKey: string): Promise<InstantToolDescriptor[]> {
  const response = await fetch(`${TOOL_LIST_BASE}?toolkits=${encodeURIComponent(slug)}&limit=100`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`Composio tool list for "${slug}" failed (${response.status}).`);
  }
  const body = (await response.json().catch(() => null)) as {
    items?: Array<{ slug?: string; name?: string; no_auth?: boolean }> | null;
  } | null;
  return (body?.items ?? []).flatMap((item) =>
    item.slug && typeof item.no_auth === "boolean"
      ? [{
          slug: item.slug,
          name: item.name ?? item.slug,
          noAuth: item.no_auth,
          riskClass: verifiedRiskClass(slug, item.slug),
        }]
      : [],
  );
}

/*
 * The verified classification comes from the generated catalog (authored with
 * read-only proof per tool); the live API response carries no such signal, so
 * a tool absent from the generated catalog is unverified — deny-by-default.
 */
function verifiedRiskClass(toolkitSlug: string, toolSlug: string): "read" | "unverified" {
  const toolkit = readInstantCatalogJson().toolkits.find((t) => t.slug === toolkitSlug);
  const tool = toolkit?.tools.find((t) => t.slug === toolSlug);
  return tool?.riskClass === "read" ? "read" : "unverified";
}

export async function listInstantTools(slug: string): Promise<InstantToolDescriptor[]> {
  const cached = listCache.get(slug);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.tools;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    if (cached) return cached.tools;
    throw new Error("Composio is not configured on this deployment yet.");
  }
  try {
    const tools = await fetchInstantTools(slug, apiKey);
    listCache.set(slug, { at: Date.now(), tools });
    return tools;
  } catch {
    if (cached) return cached.tools;
    throw new Error(`The Instant tool catalog for "${slug}" is unreachable.`);
  }
}

/**
 * Runs one Instant tool. Every refusal here happens BEFORE the spend
 * reservation: a denied call must spend nothing (the same order the gateway's
 * connected-account chain uses).
 */
export async function executeInstantTool(input: {
  toolSlug: string;
  args: Record<string, unknown>;
  workspaceId: string;
  apiKey?: string;
  /** Test/injection seam: defaults to the module-level drizzle store. */
  quotaStore?: QuotaStore;
}): Promise<InstantExecuteResult> {
  // a. Registry gate (D3): fail closed while the entry is off or unverified.
  const entry = providerEntry("composio");
  if (!entry || !entry.enabled) {
    throw new InstantToolNotExecutableError("registry_disabled", input.toolSlug);
  }
  if (!entry.verifiedAt || !entry.verificationSource) {
    throw new InstantToolNotExecutableError("registry_unverified", input.toolSlug);
  }
  // b/c. Call-time re-checks against the live-cached catalog: no_auth can flip
  // between syncs, and only a proven read runs inline (D5 deny-by-default).
  const tools = await listInstantTools(resolveInstantCapability(input.toolSlug)?.toolkitSlug ?? "");
  const tool = tools.find((t) => deriveInstantCapability(
    resolveInstantCapability(input.toolSlug)?.toolkitSlug ?? "",
    t.slug,
  ) === input.toolSlug);
  if (!tool || !tool.noAuth) {
    throw new InstantToolNotExecutableError("not_no_auth", input.toolSlug);
  }
  if (tool.riskClass !== "read") {
    throw new InstantToolNotExecutableError("write_unverified", input.toolSlug);
  }
  // d. Spend guard: reserve → execute → settle (release on throw). One tool
  // call is one request unit; the composio entry's allowance caps the month.
  const apiKey = input.apiKey ?? process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return { ok: false, code: "not_configured", message: "Composio is not configured on this deployment yet." };
  }
  const entry2 = providerEntry("composio");
  if (!entry2) {
    throw new InstantToolNotExecutableError("registry_disabled", input.toolSlug);
  }
  const quotaStore = input.quotaStore ?? drizzleQuotaStore();
  /*
   * Provider failures are thrown THROUGH withQuota so the reservation is
   * released: an unreachable or failed call never reached Composio's billing
   * the way a settled call did, and Composio refunds 4xx/5xx anyway. The
   * QuotaProviderError marker lets the outer catch turn it back into the
   * InstantExecuteResult error object without confusing it with a refusal.
   */
  class QuotaProviderError extends Error {
    constructor(readonly result: Extract<InstantExecuteResult, { ok: false }>) {
      super(result.message);
    }
  }
  try {
    return await withQuota(quotaStore, entry2, input.workspaceId, 1, async () => {
      let response: Response;
      try {
        response = await fetch(`${INSTANT_EXECUTE_BASE}/${encodeURIComponent(input.toolSlug)}`, {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ arguments: input.args }),
        });
      } catch {
        throw new QuotaProviderError({
          ok: false,
          code: "provider_error",
          message: "The Instant tool service is unreachable.",
        });
      }
      if (!response.ok) {
        throw new QuotaProviderError({
          ok: false,
          code: "provider_error",
          status: response.status,
          message: `The Instant tool service returned ${response.status}.`,
        });
      }
      const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
      if (body === null) {
        throw new QuotaProviderError({
          ok: false,
          code: "provider_error",
          message: "The Instant tool returned no parseable body.",
        });
      }
      return { ok: true, data: "data" in body ? body.data : body };
    });
  } catch (cause) {
    if (cause instanceof QuotaProviderError) return cause.result;
    throw cause;
  }
}

/**
 * Catalog sync: upsert every toolkit from the generated JSON and DELETE rows
 * whose toolkit no longer appears (display metadata only — no table holds a
 * foreign key into integration_catalog, so deletion cannot orphan anything;
 * the table has no archived_at because it spreads `recorded`, not `mutable`).
 * Bounded: 73 toolkits × 3 pages max, then abort rather than loop forever.
 */
export async function syncInstantCatalog(input: {
  apiKey: string;
  now?: Date;
}): Promise<{ upserted: number; deactivated: number }> {
  const toolkits = readInstantCatalogJson().toolkits;
  let upserted = 0;
  for (const toolkit of toolkits) {
    const pages: Array<Array<{ slug?: string; name?: string; no_auth?: boolean }>> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const url = new URL(`${TOOL_LIST_BASE}`);
      url.searchParams.set("toolkits", toolkit.slug);
      url.searchParams.set("limit", "100");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetch(url, { headers: { "x-api-key": input.apiKey } });
      if (!response.ok) {
        throw new Error(`Composio tool list for "${toolkit.slug}" failed (${response.status}).`);
      }
      const body = (await response.json().catch(() => null)) as {
        items?: Array<{ slug?: string; name?: string; no_auth?: boolean }>;
        next_cursor?: string;
      } | null;
      pages.push(body?.items ?? []);
      if (!body?.next_cursor) break;
      pageToken = body.next_cursor;
    }
    const all = pages.flat();
    const capabilityNames = all
      .filter((t) => t.slug)
      .map((t) => deriveInstantCapability(toolkit.slug, t.slug as string));
    const riskByCapability = Object.fromEntries(
      all
        .filter((t) => t.slug)
        .map((t) => [
          deriveInstantCapability(toolkit.slug, t.slug as string),
          t.no_auth === true ? "read" : "unverified",
        ]),
    );
    await db
      .insert(integrationCatalog)
      .values({
        provider: toolkit.slug,
        displayName: toolkit.displayName,
        capabilities: capabilityNames,
        riskByCapability,
        accessTiers: ["read_only"],
        requiresApproval: true,
      })
      .onConflictDoUpdate({
        target: integrationCatalog.provider,
        set: {
          displayName: toolkit.displayName,
          capabilities: capabilityNames,
          riskByCapability,
          accessTiers: ["read_only"],
        },
      });
    upserted += 1;
  }
  const deleted = await db
    .delete(integrationCatalog)
    .where(notInArray(integrationCatalog.provider, toolkits.map((t) => t.slug)))
    .returning({ provider: integrationCatalog.provider });
  return { upserted, deactivated: deleted.length };
}
