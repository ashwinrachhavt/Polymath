import { test, expect } from "@playwright/test";

/*
 * The quick-add on Today creates a task in the Inbox, which the Today scope
 * does not list — the honest outcome is a refresh plus a notice naming where
 * the task went, never a silently vanished row.
 *
 * The notebook page must navigate instantly: an async page component that
 * awaited searchParams outside Suspense made every client-side navigation log
 * "encountered URL data during prerendering or a navigation" (Next 16
 * instant-validation) and render non-instantly.
 */

test("quick-add from Today says the task went to Inbox and lists it there", async ({ page }) => {
  const title = `Inbox notice probe ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work");
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Added to Inbox. Find it under List." })).toBeVisible();
  await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);

  await page.goto("/neuralflow/work?view=list&show=list");
  await page.getByRole("searchbox", { name: /search/i }).fill(title);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
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
