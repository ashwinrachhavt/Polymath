import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the learning path (ASH-300): the cards-page control and the
 * whole click journey, against the free fixture provider
 * (GENERATION_PROVIDER=fixture) - no model key, no spend. The debrief's
 * journey lives in meeting-debrief.spec.ts since ASH-303 merged.
 *
 * Screenshots land in test-results/feature-pixels/ and upload as the
 * feature-pixels CI artifact.
 *
 * Isolation: fullyParallel runs both viewport journeys at once against one
 * scratch database, and the batch/receipt key derives from the GOAL text.
 * A shared goal made the sibling's afterAll delete poison the receipt: the
 * loser replayed the deleted note's id and the action honestly refused
 * ("path note was deleted") - the page stayed put and toHaveURL timed out.
 * Each viewport therefore learns its own goal; the fixture's canned answer
 * keeps the asserted titles identical. No cleanup: replaying a namespaced
 * goal is idempotent by design, and a per-worker afterAll cannot know which
 * viewport's rows are safe to delete.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

for (const vp of VIEWPORTS) {
  test(`a learning goal proposes notes, tasks and cards [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const client = db();
    test.skip(!client, "DATABASE_URL not configured");
    await client!.end();

    await page.goto("/alfred/knowledge/cards");
    await expect(page.getByRole("heading", { name: "Learning path", exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-form-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.getByLabel("Learning goal").fill(`understand distributed consensus (${vp.name})`);
    await page.getByRole("button", { name: "Propose learning path" }).click();

    // Success navigates to the path note.
    await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
    // Page title carries the path title (the body starts with the overview).
    await expect(
      page.getByRole("heading", { level: 1, name: "Understanding distributed consensus" }),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-note-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/alfred/knowledge/cards");
    // The sibling viewport's path proposes an identical card; .first() is the
    // honest scope, matching the Reviews assertions below.
    await expect(page.getByText("What does a quorum prevent?").first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-card-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/reviews");
    await expect(page.getByText("Add note: Why consensus is hard").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Add task: Sketch Raft's election on paper").first()).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-reviews-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });
}
