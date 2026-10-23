import { test, expect, type Page } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * Regression: a search still inside its 300ms debounce must not abort a row
 * navigation the user already started. The toolbar's debounced router.replace
 * used to fire mid-navigation, rewrite the URL from stale params and drop the
 * ?task=<id> destination — on Work the user clicked a task and stayed on the
 * list (the intermittent neuralflow.spec.ts CI failure). The fix flushes the
 * pending search on blur, which always precedes row activation, so dispatch
 * order — not timing — decides the outcome.
 *
 * The 1.2s route delay makes the old race deterministic instead of
 * load-dependent: without the fix the debounce (300ms) is guaranteed to fire
 * while the navigation request is still in flight, on every run.
 */

const TASK_LINK = 'a[href*="task="]';

async function delayWorkNavigations(page: Page) {
  await page.route("**/neuralflow/work**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/neuralflow/work?view=saved");
  await waitSettled(page);
  // The race needs one visible row to activate; a fresh workspace has none.
  if ((await page.locator(TASK_LINK).count()) === 0) {
    await page.getByLabel("New task title").fill(`Toolbar race seed ${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.locator(TASK_LINK).first()).toBeVisible();
  }
});

test("clicking a task with a search pending still opens the task", async ({ page }) => {
  await delayWorkNavigations(page);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("pending search");
  await page.locator(TASK_LINK).first().click();
  await expect(page).toHaveURL(/task=[0-9a-f-]{36}/, { timeout: 20_000 });
});

test("keyboard-activating a task with a search pending still opens the task", async ({ page }) => {
  await delayWorkNavigations(page);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("pending search");
  const row = page.locator(TASK_LINK).first();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/task=[0-9a-f-]{36}/, { timeout: 20_000 });
});
