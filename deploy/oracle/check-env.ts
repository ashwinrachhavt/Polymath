/*
 * Checks the server's environment without revealing it: each key prints as
 * "set" or "missing", and each live check prints a status code, never a value.
 * Run inside the web container, where the env file is loaded:
 *
 *   docker compose ... exec -T web pnpm exec tsx deploy/oracle/check-env.ts
 *
 * Live checks are free, read-only calls: a Postgres round trip, Clerk's JWKS,
 * each configured model provider's /models list (base URLs from the app's own
 * catalog), and the in-network docling/searxng/firecrawl services.
 * Exits 1 when a required key is missing or a required check fails.
 */
import postgres from "postgres";
import { MODEL_CATALOG } from "@/domains/agents/models";

const REQUIRED = [
  "DATABASE_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "EVE_BRIDGE_SECRET",
  "EVE_GATEWAY_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "APP_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "DOCLING_SERVE_URL",
  "SEARXNG_URL",
  "FIRECRAWL_API_URL",
] as const;

const OPTIONAL = [
  ...new Set([
    ...MODEL_CATALOG.map((m) => m.keyEnv),
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AI_GATEWAY_API_KEY",
    "COMPOSIO_API_KEY",
    "DEEPGRAM_API_KEY",
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "PARALLEL_API_KEY",
    "JINA_API_KEY",
    "LLAMAPARSE_API_KEY",
    "REDUCTO_API_KEY",
    "TYPESAFE_API_KEY",
    "CLOUDFLARE_API_KEY",
  ]),
].filter((key) => !(REQUIRED as readonly string[]).includes(key));

const env = (key: string) => process.env[key]?.trim() ?? "";
let failed = false;

function line(ok: boolean, label: string, detail: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${detail}`);
}

async function status(url: string, headers: Record<string, string> = {}): Promise<number> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("required keys");
  for (const key of REQUIRED) {
    const set = env(key).length > 0;
    if (!set) failed = true;
    line(set, key, set ? "set" : "missing");
  }
  for (const key of ["EVE_BRIDGE_SECRET", "EVE_GATEWAY_SECRET"]) {
    const ok = env(key).length >= 32;
    if (!ok) failed = true;
    line(ok, `${key} length`, ok ? ">= 32" : "< 32");
  }
  const devAuth = process.env.POLYMATH_DEV_AUTH !== undefined;
  line(!devAuth, "POLYMATH_DEV_AUTH", devAuth ? "present (must be unset)" : "unset");
  if (devAuth) failed = true;

  console.log("optional keys");
  for (const key of OPTIONAL) console.log(`       ${key.padEnd(34)} ${env(key) ? "set" : "missing"}`);

  console.log("live checks");
  try {
    const sql = postgres(env("DATABASE_URL"), { max: 1, connect_timeout: 5 });
    const [row] = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
    await sql.end();
    line(true, "postgres", `connected, ${row.n} tables`);
  } catch {
    failed = true;
    line(false, "postgres", "connection failed");
  }

  const clerk = await status("https://api.clerk.com/v1/jwks", { Authorization: `Bearer ${env("CLERK_SECRET_KEY")}` });
  if (clerk !== 200) failed = true;
  line(clerk === 200, "clerk jwks", String(clerk));

  for (const [label, url] of [
    ["docling", `${env("DOCLING_SERVE_URL")}/health`],
    ["searxng", `${env("SEARXNG_URL")}/healthz`],
    ["firecrawl", `${env("FIRECRAWL_API_URL")}/`],
  ]) {
    const code = await status(url);
    if (code === 0 || code >= 500) failed = true;
    line(code > 0 && code < 500, label, String(code));
  }

  // One probe per (base URL, key): several catalog entries share a provider.
  const seen = new Set<string>();
  for (const model of MODEL_CATALOG) {
    const key = env(model.keyEnv);
    const probe = `${model.baseUrl}|${model.keyEnv}`;
    if (!key || seen.has(probe)) continue;
    seen.add(probe);
    const code = await status(`${model.baseUrl.replace(/\/+$/, "")}/models`, { Authorization: `Bearer ${key}` });
    // Provider failures are reported, not fatal: one dead free-tier key
    // should not block a deploy while other models work.
    line(code === 200, `${model.provider} (${model.keyEnv})`, String(code));
  }

  if (env("DEEPGRAM_API_KEY")) {
    const code = await status("https://api.deepgram.com/v1/projects", {
      Authorization: `Token ${env("DEEPGRAM_API_KEY")}`,
    });
    line(code === 200, "deepgram", String(code));
  }

  process.exit(failed ? 1 : 0);
}

void main();
