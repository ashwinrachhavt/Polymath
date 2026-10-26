import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * ASH-285: drafting a Linear issue, end to end. The e2e generation fixture
 * answers the proposal, so both journeys produce real, deterministic content
 * the owner reviews - nothing is ever sent to Linear. Journey one starts
 * from a capture in the inbox, journey two from a note in the notebook.
 */

const SOURCE_TEXT = "Priya needs the Q3 roadmap by Friday and the launch date is still unconfirmed.";

test("a capture turns into a fully formed Linear issue draft", async ({ page }) => {
  await page.goto("/command-center/inbox");
  await waitSettled(page);

  // The inbox's own composer navigates straight to THIS capture's detail on
  // save (?id=). The global shell capture dialog saves without navigating,
  // and picking from the shared inbox list races every parallel spec (a
  // passing enrichment drain can rename rows mid-journey).
  const composer = page.getByLabel("Capture a thought, excerpt, or URL");
  await composer.click();
  await composer.fill(SOURCE_TEXT);
  await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
  await expect(page).toHaveURL(/\/command-center\/inbox\?id=[0-9a-f-]{36}/);
  await waitSettled(page);
  const detail = page.getByRole("article");
  await expect(detail).toContainText("Turn into");
  await detail.getByRole("button", { name: "Linear issue", exact: true }).click();
  await waitSettled(page);

  await detail.getByRole("link", { name: "Open draft", exact: true }).click();
  await expect(page).toHaveURL(/\/alfred\/notes\?id=[0-9a-f-]{36}/);
  await waitSettled(page);

  // The fixture proposal, fully formed and reviewable - and honest about scope.
  await expect(page.getByRole("main")).toContainText("Send the Q3 roadmap to Priya by Friday");
  await expect(page.getByRole("main")).toContainText("Acceptance criteria");
  await expect(page.getByRole("main")).toContainText("nothing has been sent to Linear");
});

test("a note drafts a Linear issue proposal that links back to its source", async ({ page }) => {
  await page.goto("/alfred/notes");
  await waitSettled(page);

  await page.getByRole("button", { name: "New note", exact: true }).click();
  await expect(page).toHaveURL(/\/alfred\/notes\?id=[0-9a-f-]{36}/);
  await waitSettled(page);

  const editor = page.locator(".tiptap").first();
  await editor.click();
  await editor.pressSequentially(SOURCE_TEXT);
  // The proposal reads the committed version, never the unsaved draft.
  await page.keyboard.press("Control+s");
  await waitSettled(page);

  const sourceUrl = page.url();
  await page.getByRole("button", { name: "Draft Linear issue", exact: true }).click();
  await expect(page).toHaveURL(/\/alfred\/notes\?id=[0-9a-f-]{36}/);
  await waitSettled(page);

  await expect(page.getByRole("main")).toContainText("Send the Q3 roadmap to Priya by Friday");
  await expect(page.getByRole("main")).toContainText("Acceptance criteria");
  const draftUrl = page.url();

  // Repeat from the same source: the existing proposal replays, no duplicate.
  await page.goto(sourceUrl);
  await waitSettled(page);
  await page.getByRole("button", { name: "Draft Linear issue", exact: true }).click();
  await waitSettled(page);
  await expect(page).toHaveURL(draftUrl);
});
