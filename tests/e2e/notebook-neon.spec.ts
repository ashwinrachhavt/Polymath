import { test, expect } from "@playwright/test";

/*
 * The notebook on Neon (ASH-141 / B04): create, autosave as a draft, reload
 * into the draft-recovery offer, checkpoint into the immutable history, and
 * find the text still there afterwards. Nothing lives in browser storage.
 */

test("create, autosave, recover and checkpoint a note, saved in the workspace", async ({ page }) => {
  const tag = Date.now().toString(36);
  const title = `Launch thoughts ${tag}`;
  const body = `- venue shortlist\n- invite list ${tag}`;

  // The preview product screen hands off to the canonical surface.
  await page.goto("/apps/alfred/notebook");
  await expect(page).toHaveURL(/\/alfred\/notebook/);

  await page.getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/alfred\/notebook\?id=[0-9a-f-]{36}/);
  await page.getByLabel("Note title").fill(title);
  await page.getByLabel("Note title").blur();

  await page.getByRole("button", { name: "Markdown source" }).click();
  await page.getByLabel("Markdown source").fill(body);
  // Autosave is debounced — wait for the confirmation, never reload mid-save.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Reload: the committed version is still empty, so the draft is offered.
  await page.reload();
  await expect(page.getByText(/was left unsaved/)).toBeVisible();
  await page.getByRole("button", { name: "Restore draft" }).click();
  await page.getByRole("button", { name: "Markdown source" }).click();
  await expect(page.getByLabel("Markdown source")).toHaveValue(body);

  // Checkpoint mints the next immutable version, listed in History.
  await page.getByRole("button", { name: "Save checkpoint" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // After a reload the committed text is the note — no draft banner.
  await page.reload();
  await expect(page.getByText(/was left unsaved/)).toHaveCount(0);
  await page.getByRole("button", { name: "Markdown source" }).click();
  await expect(page.getByLabel("Markdown source")).toHaveValue(body);

  // The list entry links back to the same note.
  await page.goto("/alfred/notebook");
  // No exact: the link's accessible name legitimately includes the excerpt.
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/alfred\/notebook\?id=/);
});
