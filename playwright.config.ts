import { defineConfig, devices } from "@playwright/test";

/*
 * Journeys, not pages (agents/engineering.md). The suite is deliberately small:
 * one smoke test that catches "the app does not boot, and it boots accessibly",
 * which is the class of failure a green `pnpm check` cannot see.
 *
 * Tests run against a production build, not `next dev` — a scaffold that only
 * works in dev is not scaffolded.
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
  // Reuse a server already listening; otherwise start one from the build.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm build && pnpm start",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
