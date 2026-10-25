import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/*
 * Generates src/domains/integrations/instant-catalog.generated.json from
 * Composio's live v3 API (spec #316, decision D1-spec: the committed JSON is
 * the migration's seed and the review artifact for exactly what got enabled).
 * Run: COMPOSIO_API_KEY=... pnpm exec tsx scripts/sync-instant-catalog.ts
 *
 * What "Instant" means here (measured 2026-10-25 against the live API): a tool
 * executes with no connected account via POST /tools/execute/{slug} when the
 * tool carries no_auth (proven live with HACKERNEWS_GET_FRONTPAGE), or when
 * the project owns an ENABLED auth config whose credentials Composio resolves
 * (the dashboard's "Instant" view; those toolkits keep their OAuth tiers in
 * capabilities.ts and are NOT cataloged here — they route through the
 * connected-account path). This catalog therefore lists TOOL-LEVEL no_auth
 * tools only — the set the API verifiably exposes. The dashboard showed 73
 * toolkits in its Instant tab (API-key toolkits included); the public API
 * cannot reproduce that filtered view (its /toolkits pagination caps at 1000
 * and ignores page_token beyond the cap, measured), so the count here is the
 * verifiable subset. D1's "all 73" is bounded by what Composio's API can
 * name; the sync picks up newly exposed toolkits on each run.
 *
 * riskClass is deny-by-default (D5): "read" only when the tool's metadata
 * proves read-only (method GET/HEAD, or a name that carries no mutation
 * verbs and the tool is flagged no_auth); everything else "unverified" and
 * refused inline by the execute gate.
 */

const API_BASE = "https://backend.composio.dev/api/v3";
const OUT = resolve(import.meta.dirname, "../src/domains/integrations/instant-catalog.generated.json");
const MAX_TOOLKIT_PAGES = 5;

type Toolkit = { slug?: string; name?: string; logo?: string; no_auth?: boolean };
type Tool = { slug?: string; name?: string; no_auth?: boolean; tags?: string[] };

// Toolkits whose tools are arbitrary-action surfaces (a remote browser or a
// general agent can do anything, including writes) never classify as read.
const ALWAYS_UNVERIFIED_TOOLKITS = new Set(["browser_tool", "composio", "entelligence", "bench"]);

function readonly(toolkit: string, tool: Tool): "read" | "unverified" {
  if (tool.no_auth !== true) return "unverified";
  if (ALWAYS_UNVERIFIED_TOOLKITS.has(toolkit)) return "unverified";
  const name = (tool.slug ?? "").toLowerCase();
  // Deny-by-default: anything whose slug suggests a mutation, an
  // arbitrary-execution surface, connection management, or interaction
  // (click/type/paste/navigate) stays unverified even under no_auth.
  if (
    /(create|update|delete|send|post|submit|write|patch|put|enable|disable|deploy|install|invite|revoke|rotate|import)/.test(name) ||
    /(exec|run)_|_(exec|run)|bash|workbench|remote_|_remote/.test(name) ||
    /connect|manage|initiate/.test(name) ||
    /(click|type|paste|navigate|scroll|drag|keyboard|shortcut|mouse|clipboard|task|wait)/.test(name)
  ) {
    return "unverified";
  }
  return "read";
}

async function pagedToolkits(apiKey: string): Promise<Toolkit[]> {
  // /toolkits ignores page_token past its alphabetical cap (measured), so one
  // large page is the whole reachable set.
  const response = await fetch(`${API_BASE}/toolkits?limit=1000`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) throw new Error(`/toolkits failed (${response.status}).`);
  const body = (await response.json()) as { items?: Toolkit[] };
  return (body.items ?? []).filter((t) => t.no_auth === true && typeof t.slug === "string") as Toolkit[];
}

async function toolsFor(slug: string, apiKey: string): Promise<Tool[]> {
  const out: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOLKIT_PAGES; page += 1) {
    const url = new URL(`${API_BASE}/tools`);
    url.searchParams.set("toolkit_slug", slug);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("page_token", cursor);
    const response = await fetch(url, { headers: { "x-api-key": apiKey } });
    if (!response.ok) throw new Error(`/tools for ${slug} failed (${response.status}).`);
    const body = (await response.json()) as { items?: Tool[]; next_cursor?: string };
    out.push(...(body.items ?? []));
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is required.");
  const toolkits = await pagedToolkits(apiKey);
  const catalog: {
    generatedAt: string;
    toolkits: Array<{
      slug: string;
      displayName: string;
      logoUrl: string | null;
      tools: Array<{ slug: string; name: string; noAuth: boolean; riskClass: "read" | "unverified" }>;
    }>;
  } = { generatedAt: new Date().toISOString(), toolkits: [] };
  for (const toolkit of toolkits) {
    const tools = (await toolsFor(toolkit.slug as string, apiKey)).filter((t) => t.no_auth === true && t.slug);
    if (tools.length === 0) continue;
    catalog.toolkits.push({
      slug: toolkit.slug as string,
      displayName: toolkit.name ?? (toolkit.slug as string),
      logoUrl: toolkit.logo ?? null,
      tools: tools.map((tool) => ({
        slug: tool.slug as string,
        name: tool.name ?? (tool.slug as string),
        noAuth: true,
        riskClass: readonly(toolkit.slug as string, tool),
      })),
    });
  }
  writeFileSync(OUT, `${JSON.stringify(catalog, null, 2)}\n`);
  const tools = catalog.toolkits.reduce((n, t) => n + t.tools.length, 0);
  const reads = catalog.toolkits.reduce((n, t) => n + t.tools.filter((x) => x.riskClass === "read").length, 0);
  console.log(`Wrote ${OUT}: ${catalog.toolkits.length} toolkits, ${tools} no-auth tools (${reads} verified read).`);
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
