import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

test("global capture and search open the exact shared task without losing the original", async ({ page }) => {
  await page.goto("/command-center/briefing");
  await waitSettled(page);
  const capture = page.getByRole("button", { name: "Capture", exact: true });
  await capture.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Task", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Capture content" }).fill("Cross-app capture regression\nKeep this original context");
  await dialog.getByRole("button", { name: "Save capture", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(capture).toBeFocused();

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search workspace" }).fill("Cross-app capture regression");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/neuralflow\/work\?view=list&task=/);
  await expect(page.getByRole("dialog", { name: "Task inspector" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cross-app capture regression");
  await page.keyboard.press("Escape");

  // The durable inbox proves the same retain-the-original contract against
  // Postgres: capture, convert to a canonical task, original text survives.
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByLabel("Original material").fill("Cross-app capture regression\nKeep this original context");
  await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
  const inboxOriginal = page.getByRole("article").filter({ hasText: "Cross-app capture regression" });
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

  await page.getByLabel("Original material").fill("Preserve these bytes");
  await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
  await expect(page.getByRole("article").filter({ hasText: "Preserve these bytes" })).toBeVisible();
  await page.reload();
  await waitSettled(page);
  await expect(page.getByRole("article").filter({ hasText: "Preserve these bytes" })).toBeVisible();
});
test("preview routes retain app context and all tools are reachable on a phone", async ({ page }) => {
  await page.goto("/apps/alfred/notebook");
  await waitSettled(page, { heading: "Heading" });
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Notebook");
  await expect(page.locator("[data-app]")).toHaveAttribute("data-app", "alfred");
  await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "Learning", exact: true })).toBeVisible();

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
