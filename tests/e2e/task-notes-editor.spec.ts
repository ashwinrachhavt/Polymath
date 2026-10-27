import { test, expect, type Page } from "@playwright/test";

/*
 * A task keeps its own description column; the Notes field edits it with the
 * same Markdown editor the Notes surface uses. This covers what the swap from
 * a bare textarea could break: plain text with special characters surviving a
 * save with no edit, an edit saving as Markdown and reloading, and clearing
 * the field saving as null. Screenshots land in test-results/feature-pixels/.
 */

const PLAIN = "Ship by Friday: a_b, 50% done, (call Sam)";

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

test("saving a task without touching Notes keeps the text, and clearing Notes empties it", async ({ page }) => {
  const title = `Notes keep ${Date.now().toString(36)}`;
  await openTask(page, title);
  const notes = () => page.getByRole("textbox", { name: "Rich note content" });
  await notes().click();
  await page.keyboard.type(PLAIN);
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();

  // Re-save with only another field changed: Notes must come back identical.
  await page.reload();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(notes()).toContainText("call Sam");
  const before = await notes().innerText();
  await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title }).getByText("high", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(notes()).toContainText("call Sam");
  expect(await notes().innerText()).toBe(before);

  // Clear it: after save and reload the field is empty.
  await notes().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(notes()).toBeVisible();
  await expect(notes()).not.toContainText("call Sam");
});

test("task Notes editor fits a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `Notes mobile ${Date.now().toString(36)}`;
  await openTask(page, title);
  const notes = page.getByRole("textbox", { name: "Rich note content" });
  await expect(notes).toBeVisible();
  await notes.click();
  await page.keyboard.type("Phone note");
  const box = await notes.boundingBox();
  expect(box && box.width <= 390).toBe(true);
  await page.screenshot({ path: "test-results/feature-pixels/task-notes-editor-mobile.png" });
});
