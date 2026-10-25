import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the learning path (ASH-300): the cards-page control and the
 * whole click journey, against the free fixture provider
 * (GENERATION_PROVIDER=fixture) - no model key, no spend. The debrief's
 * journey lives in meeting-debrief.spec.ts since ASH-303 merged.
 *
 * Screenshots land in test-results/feature-pixels/ and upload as the
 * feature-pixels CI artifact. The seeded rows are removed in afterAll.
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

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    // The batch's proposals and cards reference the path note; removing
    // them first keeps the developer's queue clean. The path note is
    // created by the journey itself, so it is caught by title.
    await client`delete from action_proposals where dedupe_key like 'tasks:learning-path:%' or dedupe_key like 'notes:learning-path:%'`;
    await client`delete from cards where source_title = 'Understanding distributed consensus'`;
    await client`delete from artifacts where title = 'Understanding distributed consensus'`;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

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

    await page.getByLabel("Learning goal").fill("understand distributed consensus");
    await page.getByRole("button", { name: "Propose learning path" }).click();

    // Success navigates to the path note.
    await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
    // Page title carries the path title (the body starts with the overview).
    await expect(
      page.getByRole("heading", { level: 1, name: "Understanding distributed consensus" }),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-note-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/alfred/knowledge/cards");
    await expect(page.getByText("What does a quorum prevent?")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-card-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/reviews");
    await expect(page.getByText("Add note: Why consensus is hard").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Add task: Sketch Raft's election on paper").first()).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-reviews-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });
}
