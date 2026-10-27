import { test, expect } from "@playwright/test";

/*
 * Quick-add from Today commits the task to today, so it appears in the list it
 * was typed into. This replaces an earlier contract where the task was filed
 * in Inbox (which Today does not list) and the only feedback was a notice
 * naming where it went: the row the owner just typed could not be seen without
 * navigating away, which made capture feel like it had failed.
 *
 * Adding on the List destination keeps the older behaviour - a plain capture
 * is not a commitment - so the Inbox path is still asserted below.
 *
 * The notebook page must navigate instantly: an async page component that
 * awaited searchParams outside Suspense made every client-side navigation log
 * "encountered URL data during prerendering or a navigation" (Next 16
 * instant-validation) and render non-instantly.
 */

test("quick-add from Today commits the task and shows it in place", async ({ page }) => {
  const title = `Today commit probe ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=today");
  // Today holds more than one page on a long-lived workspace and a new task
  // ranks to the end, so narrow to this row before asserting it is on screen.
  await page.getByRole("searchbox", { name: /search/i }).fill(title);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();

  const row = page.getByRole("link", { name: title, exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toContainText("Ready");
});

test("quick-add from the list captures to Inbox without committing", async ({ page }) => {
  const title = `Inbox capture probe ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=saved");
  await page.getByRole("searchbox", { name: /search/i }).fill(title);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();

  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Inbox");
  await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(1);
});

test("notebook navigation from the rail is instant and console-clean", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/alfred/notes");
  await page.getByRole("link", { name: "Notebook", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Notebook" })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
