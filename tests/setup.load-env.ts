/*
 * Give the db-backed suites the same scratch database the dev server uses.
 *
 * `pnpm test` is a bare `vitest run`, and unlike the app there is no framework
 * loading env files for it. Without this, TEST_DATABASE_URL is undefined, and
 * makeTestDb() returned null — so every integration and migration file became
 * `describe.skip`. That skip was invisible in the summary: a local run said
 * "274 passed | 179 skipped" and looked green while the migration suite that
 * guards the converge script never executed. The one suite that would have
 * caught the broken migration was the one not running.
 *
 * Only TEST_DATABASE_URL is taken from the file, deliberately. Loading the
 * whole of .env.local would also hand these suites real provider API keys, and
 * several of them assert what happens when no provider is configured — with a
 * key present they attempt the live call and fail on the fetch guard. The point
 * is a database, not a credential.
 *
 * CI is unaffected: the workflow exports TEST_DATABASE_URL on the job, and an
 * already-set variable always wins over the file.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (!process.env.TEST_DATABASE_URL) {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^\s*TEST_DATABASE_URL\s*=\s*(.*)$/m);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    // `.env` ships TEST_DATABASE_URL="" — an empty value is not a database.
    if (value) {
      process.env.TEST_DATABASE_URL = value;
      break;
    }
  }
}
