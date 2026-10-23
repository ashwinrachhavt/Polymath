import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * Bulk edit on the Work list (Product Spec: "bulk edit"): select tasks,
 * complete them in one action, and the outcome is honest - the bar shows the
 * real selected count, the message says exactly what completed and what did
 * not, and a reload proves the server's truth (nothing lives in browser
 * storage). The per-item guards the bulk path composes over are covered
 * against real Postgres in tests/integration/work-bulk-complete.test.ts.
 *
 * Screenshots land in test-results/bulk-pixels/ and upload as the
 * bulk-complete-pixels CI artifact. They are viewport captures (no full-page
 * stitching) taken only once the UI has settled - the mixed-outcome frame
 * waits for the refresh to reconcile the list, so no capture shows a
 * mid-transition state that disagrees with its own message.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env locally; CI exports DATABASE_URL.
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

// Dev-harness chrome (the "Rendering…" activity pill lives in the nextjs-portal
// shadow host) is tooling, not app UI: it must never appear in a review pixel.
// App-state truth is proven by the assertions before every capture.
const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";

async function settle(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function addTask(page: Page, title: string) {
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  // The link (not the optimistic span) means the server row is back.
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test(`select tasks, complete them in bulk, and it sticks after reload [${vp.name}]`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const tag = `${Date.now().toString(36)}${vp.name[0]}`;
    const a = `Bulk one ${tag}`;
    const b = `Bulk two ${tag}`;
    await page.goto("/neuralflow/work?view=saved");
    await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
    await addTask(page, a);
    await addTask(page, b);

    await page.getByLabel(`Select ${a}`).check();
    await page.getByLabel(`Select ${b}`).check();
    // The action bar reflects the actual selection state, not a claim.
    await expect(page.getByLabel(`Select ${a}`)).toBeChecked();
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    // The bar itself, framed tight: the count and the checked state it acts on.
    await page.getByRole("group", { name: "Bulk selection actions" }).screenshot({ path: `test-results/bulk-pixels/selected-bar-${vp.name}.png` });
    await page.getByRole("button", { name: "Complete 2 selected" }).click();
    await expect(page.getByText("Completed 2 tasks.", { exact: true })).toBeVisible();
    // Settled: the server-driven refresh has reconciled the list (dev
    // compile makes the round-trip slow; give it room).
    await expect(page.getByRole("link", { name: a, exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);

    // Persisted: a reload reads the server, and completed work stays gone.
    await page.reload();
    await expect(page.getByRole("link", { name: a, exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: `test-results/bulk-pixels/completed-settled-${vp.name}.png`, style: HIDE_DEV_CHROME });
  });

  test(`a task that moved on behind the page's back is named as not completed [${vp.name}]`, async ({ page }) => {
    const sql = db();
    if (!sql) {
      test.skip(true, "DATABASE_URL required to move a task mid-journey");
      return;
    }
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const tag = `${Date.now().toString(36)}${vp.name[0]}`;
    const a = `Bulk partial ${tag}`;
    const b = `Bulk moved ${tag}`;
    try {
      await page.goto("/neuralflow/work?view=saved");
      await addTask(page, a);
      await addTask(page, b);

      // b completes elsewhere before the page acts on it.
      await sql`update tasks set status = 'done', completed_at = now(), version = version + 1 where title = ${b}`;

      await page.getByLabel(`Select ${a}`).check();
      await page.getByLabel(`Select ${b}`).check();
      await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Complete 2 selected" }).click();
      await expect(
        page.getByText("Completed 1 of 2. 1 could not be completed (already done or no longer available).", { exact: true }),
      ).toBeVisible();
      // Settled before the capture: the refresh removed both rows, so the
      // frame shows the message AND the reconciled list agreeing with it.
      await expect(page.getByRole("link", { name: a, exact: true })).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);
      await settle(page);
      await page.screenshot({ path: `test-results/bulk-pixels/mixed-outcome-${vp.name}.png`, style: HIDE_DEV_CHROME });

      // The server's truth after reload: both stay gone - a through this
      // action, b through the earlier completion this one honestly named.
      await page.reload();
      await expect(page.getByRole("link", { name: a, exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);
      await settle(page);
      await page.screenshot({ path: `test-results/bulk-pixels/partial-settled-${vp.name}.png`, style: HIDE_DEV_CHROME });
    } finally {
      await sql.end();
    }
  });
}
