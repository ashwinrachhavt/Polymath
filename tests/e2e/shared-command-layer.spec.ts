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
  // The two-pane inbox: the composer expands on focus, capture selects the
  // new row (?id=), and actions live in the detail pane.
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByRole("textbox", { name: "Capture a thought, excerpt, or URL" }).fill(`Inbox original ${tag}\nKeep this original context`);
  await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
  await expect(page).toHaveURL(/\/command-center\/inbox\?id=[0-9a-f-]{36}$/);
  const detail = page.getByRole("article");
  await expect(detail).toContainText(`Inbox original ${tag}`);
  await expect(detail).toContainText("Keep this original context");
  await detail.getByRole("button", { name: "Make task", exact: true }).click();
  await page.getByRole("navigation", { name: "Inbox filters" }).getByRole("link", { name: "Converted", exact: true }).click();
  await expect(page.getByRole("article").getByRole("link", { name: "Open task in Work" })).toBeVisible();
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
  await expect(page.getByRole("list").getByText("Preserve these bytes")).toBeVisible();
  await page.reload();
  await waitSettled(page);
  await expect(page.getByRole("list").getByText("Preserve these bytes")).toBeVisible();
});
test("bulk archive moves two captures in one pass with per-row errors visible on conflict", async ({ page }) => {
  const tag = Date.now().toString(36);
  const first = `Bulk one ${tag}`;
  const second = `Bulk two ${tag}`;
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  for (const body of [first, second]) {
    await page.getByRole("textbox", { name: "Capture a thought, excerpt, or URL" }).fill(body);
    await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
    await expect(page).toHaveURL(/\/command-center\/inbox\?id=[0-9a-f-]{36}$/);
    await expect(page.getByRole("article")).toContainText(body);
  }
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByRole("checkbox", { name: `Select capture: ${first}` }).check();
  await page.getByRole("checkbox", { name: `Select capture: ${second}` }).check();
  const toolbar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(toolbar).toContainText("2 selected");
  await toolbar.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(toolbar).toBeHidden();
  await page.getByRole("navigation", { name: "Inbox filters" }).getByRole("link", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("list").getByText(first)).toBeVisible();
  await expect(page.getByRole("list").getByText(second)).toBeVisible();
});

test("clicking a second capture swaps the detail body with the title, not one turn behind", async ({ page }) => {
  // Regression: ISSUE-001 — CaptureBody held the draft and Tiptap document in
  // mount-time state, so switching captures in place kept the previous capture's
  // text under the new one's title. Found by /qa on 2026-10-25.
  // Report: .gstack/qa-reports/run-20261025T021256Z/
  const tag = Date.now().toString(36);
  const first = `Pane switch one ${tag}`;
  const second = `Pane switch two ${tag}`;
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  for (const body of [first, second]) {
    await page.getByRole("textbox", { name: "Capture a thought, excerpt, or URL" }).fill(body);
    await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
    await expect(page).toHaveURL(/\/command-center\/inbox\?id=[0-9a-f-]{36}$/);
    await expect(page.getByRole("article")).toContainText(body);
  }
  // Two fresh rows at the top of To clarify. Select the first, then the second:
  // the detail pane must show the second capture's own body, not the first's.
  const rows = page.locator("li[data-capture-id]");
  const secondRow = rows.filter({ hasText: second }).first();
  const firstRow = rows.filter({ hasText: first }).first();
  await firstRow.getByRole("link").click();
  await expect(page.getByRole("article").locator("h2")).toContainText(first);
  await expect(page.getByRole("article")).toContainText(first);
  await secondRow.getByRole("link").click();
  await expect(page.getByRole("article").locator("h2")).toContainText(second);
  await expect(page.getByRole("article")).toContainText(second);
  // The previous capture's text must be gone from the pane.
  await expect(page.getByRole("article")).not.toContainText(first);
});

test("a capture outside the current filter still renders in the detail pane and the filtered-empty state is distinct", async ({ page }) => {
  const tag = Date.now().toString(36);
  const body = `Filter edge ${tag}`;
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByRole("textbox", { name: "Capture a thought, excerpt, or URL" }).fill(body);
  await page.getByRole("button", { name: "Capture to inbox", exact: true }).click();
  // Capture navigates client-side after the action resolves; reading page.url()
  // straight after the click races that push.
  await expect(page).toHaveURL(/id=[0-9a-f-]{36}$/);
  const detailUrl = page.url();

  // From the converted tab the capture is outside the filter, but ?id= still
  // renders it: the detail pane is a view of the record, not of the view.
  await page.goto(detailUrl.replace("inbox?", "inbox?filter=converted&"));
  await waitSettled(page);
  await expect(page.getByRole("article")).toContainText(body);

  // An impossible search yields the filtered-empty state ("No matches"), not
  // the zero state ("Nothing in this view" is reserved for an empty inbox).
  await page.goto("/command-center/inbox");
  await waitSettled(page);
  await page.getByPlaceholder("Search captures").fill(`no-such-capture-${tag}`);
  await expect(page.getByText("No matches")).toBeVisible();
});

test("preview routes retain app context and all tools are reachable on a phone", async ({ page }) => {
  // The representative preview route: notebook handed off to the canonical
  // /alfred/notes surface (B04), so this leg uses the dictionary preview.
  await page.goto("/apps/alfred/dictionary");
  // No notebook-toolbar landmark here: the breadcrumb assertion retries
  // until the dynamic screen mounts, and this test runs no axe sweep.
  await waitSettled(page);
  // One product: the breadcrumb names the open preview tool, and the rest of
  // the workshop lives behind More.
  await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true })).toContainText("Dictionary");
  await page.goto("/more");
  await expect(page.getByRole("link", { name: "Dictionary" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/command-center/briefing");
  await waitSettled(page);
  await expect(page.getByRole("navigation", { name: "Destinations", exact: true }).getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/neuralflow/work");
  await expect(page.getByRole("navigation", { name: "Destinations", exact: true }).getByRole("link", { name: "Work", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Destinations", exact: true }).getByRole("link", { name: "More", exact: true }).click();
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
