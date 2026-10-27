import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

/*
 * Navigation-speed budget (the "snappiest AI SaaS" bar: instant transitions).
 *
 * Runs against the same keyless dev server as the rest of the suite, so
 * absolute numbers include turbopack's dev overhead and are NOT production
 * numbers - the production before/after comes from Vercel previews (capped
 * until Monday) and this spec re-runs there via E2E_BASE_URL. What CI gives us
 * is a consistent machine: regressions on the same route show up as deltas on
 * the same hardware.
 *
 * Budgets are enforced only with PERF_BUDGET_ENFORCE=1; until the baseline
 * lands, every run reports timings as annotations and a JSON artifact.
 */

test.skip(!process.env.DATABASE_URL, "Canonical routes read Postgres; skipping without DATABASE_URL.");
// A timing spec gains nothing from a retry, and the re-run's extra route
// loads multiply turbopack compile pressure on the shared dev server.
test.describe.configure({ retries: 0 });

const HERO_ROUTES = [

  { path: "/reviews", name: "Reviews" },
  { path: "/neuralflow/work", name: "Work" },
  { path: "/command-center/inbox", name: "Inbox" },
] as const;

// Dev-mode ceilings, deliberately generous until a real baseline lands.
const FULL_NAV_TTFB_MS = Number(process.env.PERF_BUDGET_TTFB_MS ?? 5_000);
const CLIENT_NAV_MS = Number(process.env.PERF_BUDGET_CLIENT_NAV_MS ?? 4_000);
const ENFORCE = process.env.PERF_BUDGET_ENFORCE === "1";

test("hero route transitions stay inside the navigation budget", async ({ page }) => {
  test.setTimeout(120_000);
  const report: Record<string, { fullNavTtfbMs?: number; clientNavMs?: number }> = {};

  // Warm turbopack's on-demand compile for every route before timing anything.
  for (const route of HERO_ROUTES) {
    await page.goto(route.path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main#content")).toBeVisible();
  }

  // Full navigation TTFB: only measured against a production build
  // (E2E_BASE_URL); under turbopack dev the number is compile noise.
  for (const route of process.env.E2E_BASE_URL ? HERO_ROUTES : []) {
    const response = await page.goto(route.path, { waitUntil: "commit" });
    expect(response, `no response for ${route.path}`).not.toBeNull();
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return nav ? nav.responseStart : Number.NaN;
    });
    report[route.path] = { ...report[route.path], fullNavTtfbMs: Math.round(timing) };
    await expect(page.locator("main#content")).toBeVisible();
  }

  // Client-side transitions: click the in-shell link, time to new content.
  // The shell has one flat rail and no app layer to switch between: every
  // hero route, shared Reviews included, is one Workspace-nav click away.
  for (const route of HERO_ROUTES) {
    const link = page.locator(`nav[aria-label="Workspace"] a[href="${route.path}"]`).first();
    await expect(link, `shell link to ${route.path}`).toBeVisible();
    const started = Date.now();
    await link.click();
    await page.waitForURL(`**${route.path}**`);
    await expect(page.locator("main#content h1, main#content [role='heading']").first()).toBeVisible();
    report[route.path] = { ...report[route.path], clientNavMs: Date.now() - started };
  }

  for (const [path, timings] of Object.entries(report)) {
    test.info().annotations.push({ type: "perf", description: `${path} ttfb=${timings.fullNavTtfbMs}ms clientNav=${timings.clientNavMs}ms` });
  }
  writeFileSync("perf-budget-report.json", JSON.stringify({ at: new Date().toISOString(), mode: process.env.E2E_BASE_URL ? "production" : "dev", report }, null, 2));

  if (ENFORCE) {
    for (const [path, timings] of Object.entries(report)) {
      if (timings.fullNavTtfbMs !== undefined) {
        expect(timings.fullNavTtfbMs, `${path} full-navigation TTFB`).toBeLessThan(FULL_NAV_TTFB_MS);
      }
      expect(timings.clientNavMs ?? 0, `${path} client navigation`).toBeLessThan(CLIENT_NAV_MS);
    }
  }
});
