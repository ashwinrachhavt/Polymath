import { expect, test } from "@playwright/test";

/*
 * The Alfred -> Polymath rename (branch zettels, step 1): every old URL keeps
 * working through a redirect bridge. These journeys type what a bookmark, a
 * docs page or muscle memory would — no test re-derives the mapping from
 * next.config.ts, because the contract is what the browser receives, not what
 * the config declares.
 */

test("/alfred/* redirects to /polymath/*", async ({ page }) => {
  const response = await page.goto("/alfred/knowledge");
  // The redirect is temporary (permanent: false) — 307, not 308.
  expect(response?.status()).toBe(200); // Playwright follows redirects; landing = 200
  await expect(page).toHaveURL(/\/polymath\/knowledge$/);
});

test("/alfred root redirects to /polymath", async ({ page }) => {
  await page.goto("/alfred");
  await expect(page).toHaveURL(/\/polymath$/);
});

test("/apps/alfred/* redirects through /apps/polymath/* to the real screen", async ({ page }) => {
  // The /apps preview tools are retired: /apps/polymath/notebook now lands on Notes.
  await page.goto("/apps/alfred/notebook");
  await expect(page).toHaveURL(/\/polymath\/notes$/);
});

test("a deep alfred route carries its path across", async ({ page }) => {
  await page.goto("/alfred/knowledge?doc=x");
  await expect(page).toHaveURL(/\/polymath\/knowledge\?doc=x$/);
});
