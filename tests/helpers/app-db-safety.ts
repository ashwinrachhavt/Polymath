import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Integration suites that truncate every table must never point
 * TEST_DATABASE_URL at the application database. The reference is the
 * operator-declared value in the env files the app itself loads — not
 * process.env.DATABASE_URL, which any layer between the shell and the test
 * worker can repoint: makeTestDb() sets it to the scratch db inside workers,
 * and a long-lived tmux server or CI workflow can shadow the .env value
 * before vitest even starts (observed in the repo sandbox).
 */
export function declaredAppDatabaseUrl(cwd = process.cwd()): string | null {
  for (const name of [".env.local", ".env"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  return null;
}

export function assertTestDatabaseIsScratch(): void {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) return;

  const declared = declaredAppDatabaseUrl();
  const runStart = process.env.POLYMATH_APP_DATABASE_URL_AT_START;

  if (declared && testUrl === declared) {
    throw new Error(
      "TEST_DATABASE_URL equals the application DATABASE_URL declared in .env — this suite truncates every table. Point TEST_DATABASE_URL at a scratch database or a Neon branch.",
    );
  }
  if (runStart && testUrl === runStart && declared) {
    // The .env-declared main database differs, so nothing here can touch it;
    // a parent process is shadowing the file value. Loud, not fatal.
    console.warn(
      "[db-safety] process.env.DATABASE_URL equals TEST_DATABASE_URL, shadowing the .env value — app code inside these tests will use the scratch database.",
    );
    return;
  }
  if (runStart && testUrl === runStart) {
    throw new Error(
      "TEST_DATABASE_URL equals the DATABASE_URL this run started with. This suite truncates every table; use a scratch database or a Neon branch.",
    );
  }
}
