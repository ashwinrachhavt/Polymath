import { existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/** Match the dev harness without replacing explicit process configuration. */
export function loadE2eEnvironment(directory = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    const path = join(directory, name);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

export function databaseUrl(directory = process.cwd()): string | null {
  loadE2eEnvironment(directory);
  return process.env.DATABASE_URL || null;
}

export interface E2eDatabase extends AsyncDisposable {
  readonly sql: postgres.Sql;
}

/** Each operation owns its connection, including assertion and cleanup failures. */
export function openDatabase(url = databaseUrl()): E2eDatabase | null {
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  return { sql, [Symbol.asyncDispose]: async () => { await sql.end(); } };
}

export function isIsolatedDatabase(url: string): boolean {
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return /e2e|test|scratch/i.test(name);
  } catch {
    return false;
  }
}

export function gatewayUrl(baseURL: string | undefined): URL {
  if (!baseURL) throw new Error("The connectors gateway requires a Playwright baseURL");
  return new URL("/api/mcp", baseURL);
}
