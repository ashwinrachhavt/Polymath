import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

test("global capture and search open the exact shared task without losing the original", async ({ page }) => {
  const tag = Date.now().toString(36);
  const shared = `Cross-app capture regression ${tag}`;
  await page.goto("/command-center/briefing");
  await waitSettled(page);
  const capture = page.getByRole("button", { name: "Capture", exact: true });
  await capture.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Task", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Capture content" }).fill(`${shared}\nKeep this original context`);
  await dialog.getByRole("button", { name: "Save capture", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(capture).toBeFocused();

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search workspace" }).fill(shared);
  const hit = page.getByRole("option", { name: new RegExp(shared) });
  await expect(hit).toBeVisible();
  await hit.click();
  // The same canonical record: the search hit opens the saved task's detail.
  await expect(page).toHaveURL(/\/neuralflow\/work\?view=saved&task=[0-9a-f-]{36}/);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(shared);

  // The durable inbox proves the same retain-the-original contract against
  // Postgres: capture, convert to a canonical task, original text survives.
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByLabel("Original material").fill(`Inbox original ${tag}\nKeep this original context`);
  await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
  const inboxOriginal = page.getByRole("article").filter({ hasText: `Inbox original ${tag}` });
  await expect(inboxOriginal).toContainText("Keep this original context");
  await inboxOriginal.getByRole("button", { name: "Make task", exact: true }).click();
  await page.getByRole("navigation", { name: "Inbox filters" }).getByRole("link", { name: "Converted", exact: true }).click();
  await expect(inboxOriginal).toContainText("Keep this original context");
  await expect(inboxOriginal.getByRole("link", { name: "Open task in NeuralFlow" })).toBeVisible();
});

test("the header capture dialog validates pasted URLs and a captured item survives reload in the durable inbox", async ({ page }) => {
  // File capture returns with the blob pipeline (captures.blob_id ->
  // blob_objects); the durable inbox handles text and URLs first.
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Paste a URL or text to import" }).fill("https://%");
  await dialog.getByRole("button", { name: "Add pasted item", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("valid http or https URL");
  await page.keyboard.press("Escape");

  // Header capture writes the durable inbox directly: the item survives reload.
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Capture content" }).fill("Preserve these bytes");
  await page.getByRole("dialog").getByRole("button", { name: "Save capture", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await expect(page.getByRole("article").filter({ hasText: "Preserve these bytes" })).toBeVisible();
  await page.reload();
  await waitSettled(page);
  await expect(page.getByRole("article").filter({ hasText: "Preserve these bytes" })).toBeVisible();
});
test("preview routes retain app context and all tools are reachable on a phone", async ({ page }) => {
  // The representative preview route: notebook handed off to the canonical
  // /alfred/notebook surface (B04), so this leg uses the dictionary preview.
  await page.goto("/apps/alfred/dictionary");
  // No notebook-toolbar landmark here: the breadcrumb assertion retries
  // until the dynamic screen mounts, and this test runs no axe sweep.
  await waitSettled(page);
  // The pill nav names the open workshop tool in its last pill; the rest of
  // the workshop sits behind it.
  const workspaceNav = page.getByRole("navigation", { name: "Workspace", exact: true });
  await expect(workspaceNav).toContainText("Dictionary");
  await expect(page.locator("[data-app]")).toHaveAttribute("data-app", "alfred");
  await workspaceNav.getByRole("button", { name: "Dictionary", exact: true }).click();
  await expect(page.getByRole("link", { name: "Learning", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await expect(page.getByRole("navigation", { name: "Apps", exact: true }).getByRole("link", { name: "Command Center", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/neuralflow/focus");
  await expect(page.getByRole("navigation", { name: "Apps", exact: true }).getByRole("link", { name: "NeuralFlow", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Apps", exact: true }).getByRole("link", { name: "More", exact: true }).click();
  await expect(page).toHaveURL(/\/more$/);
  const content = page.locator("#content");
  await expect(content.getByRole("link", { name: /Stone collection/ })).toBeVisible();
  await expect(content.getByRole("link", { name: /Document vault/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("keyboard search handles an empty result set and remains accessible", async ({ page }) => {
  await page.goto("/neuralflow/work");
  await waitSettled(page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Search workspace" }).fill("no-matching-record-887341");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status")).toContainText("No results");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Search workspace", exact: true })).toBeFocused();
});
