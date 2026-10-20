import { test, expect } from "@playwright/test";

/*
 * The notebook on Neon (ASH-141 / B04): create, autosave as a draft, reload
 * into the draft-recovery offer, checkpoint into the immutable history, and
 * find the text still there afterwards. Nothing lives in browser storage.
 */


/* Properties, checkpoints, history, links and the editing mode live behind
 * the Note details inspector now (the minimal notebook): open it first. */
async function openDetails(page: import("@playwright/test").Page) {
  const toggle = page.getByRole("button", { name: "Note details", includeHidden: true });
  if ((await toggle.getAttribute("aria-expanded")) === "true") return;
  await expect(page.getByRole("dialog", { name: "Note details", exact: true })).toBeHidden();
  await toggle.click();
  await expect(page.getByRole("dialog", { name: "Note details", exact: true })).toBeVisible();
}

test("create, autosave, recover and checkpoint a note, saved in the workspace", async ({ page }) => {
  test.setTimeout(90_000);
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

  await openDetails(page);
  await page.getByRole("button", { name: "Markdown source" }).click();
  await page.getByLabel("Markdown source").fill(body);
  // Autosave is debounced — wait for the confirmation, never reload mid-save.
  // The rename's own "Saved" badge must not satisfy this: the dirty badge has
  // to show first, proving this Saved belongs to the body autosave.
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Reload: the committed version is still empty, so the draft is offered.
  await page.reload();
  await expect(page.getByText(/was left unsaved/)).toBeVisible();
  await page.getByRole("button", { name: "Restore draft" }).click();
  await openDetails(page);
  await page.getByRole("button", { name: "Markdown source" }).click();
  await expect(page.getByLabel("Markdown source")).toHaveValue(body);

  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Checkpoint mints the next immutable version, listed in History.
  await openDetails(page);
  await page.getByRole("button", { name: "Save checkpoint" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await openDetails(page);
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // After a reload the committed text is the note — no draft banner.
  await page.reload();
  await expect(page.getByText(/was left unsaved/)).toHaveCount(0);
  await openDetails(page);
  await page.getByRole("button", { name: "Markdown source" }).click();
  await expect(page.getByLabel("Markdown source")).toHaveValue(body);

  // The list entry links back to the same note.
  await page.goto("/alfred/notebook");
  // No exact: the link's accessible name legitimately includes the excerpt.
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/alfred\/notebook\?id=/);
});

test("a [[wiki link]] becomes an edge both notes can see", async ({ page }) => {
  test.setTimeout(90_000);
  const tag = Date.now().toString(36);
  const targetTitle = `Link target ${tag}`;
  const sourceTitle = `Link source ${tag}`;

  // The target note, renamed and confirmed server-side (link resolution
  // matches the current title at autosave time).
  await page.goto("/alfred/notebook");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/alfred\/notebook\?id=[0-9a-f-]{36}/);
  const targetUrl = page.url();
  await page.getByLabel("Note title").fill(targetTitle);
  await page.getByLabel("Note title").blur();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Note title")).toHaveValue(targetTitle);

  // The source note points at it by title.
  await page.goto("/alfred/notebook");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/alfred\/notebook\?id=[0-9a-f-]{36}/);
  await page.getByLabel("Note title").fill(sourceTitle);
  await page.getByLabel("Note title").blur();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Note title")).toHaveValue(sourceTitle);
  await openDetails(page);
  await page.getByRole("button", { name: "Markdown source" }).click();
  await page.getByLabel("Markdown source").fill(`see [[${targetTitle}]]`);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // The target reads the reverse edge; following it lands on the source,
  // whose own panel shows the forward edge.
  await page.goto(targetUrl);
  await openDetails(page);
  await expect(page.getByText("Links to this note", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: sourceTitle, exact: true }).click();
  await expect(page.getByLabel("Note title")).toHaveValue(sourceTitle);
  await openDetails(page);
  await expect(page.getByText("References", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: targetTitle, exact: true })).toBeVisible();
});


test("Ask AI stages a request and reports honestly when the agent bridge is unconfigured", async ({ page }) => {
  const tag = Date.now().toString(36);

  await page.goto("/alfred/notebook");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/alfred\/notebook\?id=[0-9a-f-]{36}/);
  await page.getByLabel("Note title").fill(`AI staging ${tag}`);
  await page.getByLabel("Note title").blur();

  await openDetails(page);
  await page.getByRole("button", { name: "Markdown source" }).click();
  await page.getByLabel("Markdown source").fill(`a rough draft ${tag} with too many words in it`);
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // The menu names the passage it will act on; no selection means the whole note.
  await page.getByRole("button", { name: "Ask AI" }).click();
  await expect(page.getByText(/Acts on the whole note/)).toBeVisible();
  await page.getByRole("button", { name: "Improve writing" }).click();

  // CI has no Eve bridge, so the request refuses honestly instead of faking a run.
  await expect(page.getByText(/Agent execution is unavailable/)).toBeVisible();
  // Nothing was written into the note.
  await expect(page.getByLabel("Markdown source")).toHaveValue(`a rough draft ${tag} with too many words in it`);
});
