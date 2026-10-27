import { test, expect, type Page } from "@playwright/test";
import { cleanupSeededTasks, readTaskDescription, seedTask } from "./helpers/tasks";


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

/*
 * Legacy descriptions seeded straight into the column, then saved through the
 * form after changing only Priority. The stored bytes must not move: one case
 * the rich editor represents, one it cannot (raw HTML opens in source mode).
 * Then each is cleared and must store null.
 */
const LEGACY: Array<{ label: string; text: string; source: boolean }> = [
  { label: "plain", text: "Ship by Friday: a_b, 50% done, (call Sam)\n\n* star", source: false },
  { label: "raw html", text: "Keep <b>this</b> exactly\n<!-- and this -->", source: true },
];

for (const legacy of LEGACY) {
  test(`legacy ${legacy.label} Notes survive an unrelated save byte for byte, and clearing stores null`, async ({ page }) => {
    const title = `Legacy ${legacy.label} ${Date.now().toString(36)}`;
    const seeded = await seedTask({ title, description: legacy.text });
    test.skip(!seeded, "no database configured for seeding");
    const id = seeded!.id;
    await page.goto("/neuralflow/work?view=saved");
    await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
    await page.getByRole("link", { name: title, exact: true }).click();
    const field = legacy.source
      ? page.getByRole("textbox", { name: "Markdown source" })
      : page.getByRole("textbox", { name: "Rich note content" });
    await expect(field).toBeVisible();

    await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("high");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: title }).getByText("high", { exact: true })).toBeVisible();
    expect((await readTaskDescription(id))?.description).toBe(legacy.text);

    await page.reload();
    await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
    await page.getByRole("link", { name: title, exact: true }).click();
    await expect(field).toBeVisible();
    await field.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect.poll(async () => (await readTaskDescription(id))?.description ?? "unset", { timeout: 15_000 }).toBe("unset");
  });
}

test.afterAll(async () => {
  await cleanupSeededTasks();
});
