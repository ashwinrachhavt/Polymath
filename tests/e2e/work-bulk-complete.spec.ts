import { test, expect } from "@playwright/test";

/*
 * Bulk edit on the Work list (Product Spec: "bulk edit"): select several
 * tasks, complete them in one action, and the outcome is honest - the
 * message says exactly what completed, and after a reload the completed work
 * is gone from the open list (nothing here lives in browser storage). The
 * per-item guards the bulk path composes over (terminal tasks and other
 * workspaces are skipped and named, never absorbed) are covered against real
 * Postgres in tests/integration/work-bulk-complete.test.ts.
 */

test("select tasks, complete them in bulk, and it sticks after reload", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = `Bulk one ${tag}`;
  const b = `Bulk two ${tag}`;
  await page.goto("/neuralflow/work?view=saved");
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();

  for (const title of [a, b]) {
    await page.getByLabel("New task title").fill(title);
    await page.getByRole("button", { name: "Add task" }).click();
    // The link (not the optimistic span) means the server row is back.
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  }

  await page.getByLabel(`Select ${a}`).check();
  await page.getByLabel(`Select ${b}`).check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Complete 2 selected" }).click();
  await expect(page.getByText("Completed 2 tasks.", { exact: true })).toBeVisible();

  // Persisted: a reload reads the server, and completed work left the list.
  await page.reload();
  await expect(page.getByRole("link", { name: a, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);
});
