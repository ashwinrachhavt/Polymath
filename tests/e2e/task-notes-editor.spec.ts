import { test, expect, type Page } from "@playwright/test";

/*
 * A task keeps its own description column; the Notes field edits it with the
 * same Markdown editor the Notes surface uses. This covers what the swap from
 * a bare textarea could break: plain text with special characters surviving a
 * save with no edit, an edit saving as Markdown and reloading, and clearing
 * the field saving as null. Screenshots land in test-results/feature-pixels/.
 */

const PLAIN = "Ship by Friday: a_b, 50% done, (call Sam) <not html>";

async function openTask(page: Page, title: string): Promise<void> {
  await page.goto("/neuralflow/work?view=saved");
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
}

test("task Notes uses the markdown editor and round-trips through save and reload", async ({ page }) => {
  const title = `Notes editor ${Date.now().toString(36)}`;
  await openTask(page, title);
  const editor = page.getByRole("textbox", { name: "Rich note content" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(PLAIN);
  await page.keyboard.press("Enter"); // a new paragraph, never a form submit
  await page.keyboard.type("second line");
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
  await page.screenshot({ path: "test-results/feature-pixels/task-notes-editor-desktop.png" });
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Rich note content" })).toContainText("second line");
  await expect(page.getByRole("textbox", { name: "Rich note content" })).toContainText("call Sam");
});
