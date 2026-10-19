import { defineConfig, devices } from "@playwright/test";

/*
 * Journeys, not pages (agents/engineering.md). The suite is deliberately small:
 * one smoke test that catches "the app does not boot, and it boots accessibly",
 * which is the class of failure a green `pnpm check` cannot see.
 *
 * The keyless local harness runs `next dev`; CI separately checks the production
 * build. See webServer below for the development-auth constraint.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  // Reuse a server already listening; otherwise start the keyless dev harness.
  //
  // `next start` runs with NODE_ENV=production, where the keyless dev-auth
  // fallback in lib/auth.ts stands down and Clerk's auth() throws for want of
  // a mounted proxy — every authed route 500s. E2E runs keyless, so the
  // server is `next dev` behind Playwright's proxy: same routes, same
  // Postgres reads, auth resolves to the dev owner. DATABASE_URL comes from
  // the caller (CI's postgres service, or the developer's env).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
