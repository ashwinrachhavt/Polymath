import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

test("every Work view reads the same canonical Neon task", async ({ page }) => {
  const title = `Canonical work ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=list");
  await waitSettled(page);
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  // New tasks rank to the end of the global order; on a long-lived workspace
  // that is past page one, so narrow the list to this test's row first.
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  // Durable: a reload reads Neon, not browser storage.
  await page.reload();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();

  // Commit it: Ready puts the same record on Today.
  await page.getByRole("link", { name: title, exact: true }).click();
  await page.getByRole("combobox", { name: "Status" }).selectOption("ready");
  await page.getByRole("button", { name: "Save task" }).click();
  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  // Board and Calendar read the same rows.
  await page
    .getByRole("navigation", { name: "Presentation" })
    .getByRole("link", { name: "Board", exact: true })
    .click();
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Presentation" })
    .getByRole("link", { name: "Calendar", exact: true })
    .click();
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Previous week", exact: true })).toBeVisible();
  // The relocated tools live in their contextual homes, wired to the real
  // workflows: the week grid and toolbar ARE the scheduler (no preview hop),
  // Meetings opens today's flow, and the capture/review/reward links beside
  // Today's list reach real surfaces. Every one must actually reach its tool,
  // not just render a label.
  await expect(page.getByRole("button", { name: "+ Add block", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Scheduler", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Meetings", exact: true }).click();
  await expect(page).toHaveURL(/\/neuralflow\/work\?view=today$/);
  const related = page.getByRole("navigation", { name: "Related tools", exact: true });
  await expect(related.getByRole("link", { name: "Weekly review" })).toHaveAttribute("href", "/neuralflow/reports");
  await related.getByRole("link", { name: "Brain dump" }).click();
  await expect(page).toHaveURL(/\/command-center\/inbox$/);
  await page.goBack();
  await page
    .getByRole("navigation", { name: "Related tools", exact: true })
    .getByRole("link", { name: "Stone collection" })
    .click();
  await expect(page).toHaveURL(/\/learn\/stones$/);
});

test("a canonical task deep link opens its detail and starts a focus session from Work", async ({ page }) => {
  const title = `Focus linked ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=saved");
  await waitSettled(page);
  // A new task ranks to the end of the list, which on a long-lived workspace
  // is past the first page; narrow first so the row is on screen to assert.
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/task=[0-9a-f-]{36}/);
  // Focus left the rail (IA simplification): the detail panel owns the focus
  // entry point and the session history on Work, and the focus address is the
  // real screen now — the redirect bridge is gone.
  await expect(page.getByText("Focus history", { exact: true })).toBeVisible();
  await expect(page.getByText("No focus sessions against this task yet.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await page.waitForURL(/\/neuralflow\/focus$/);
  await expect(page.getByRole("timer")).toBeVisible();
  // Leaving a session is the two-step door: request, then confirm. The
  // default tier's cooldown is 0, so the confirm enables immediately; the
  // session ends and the summary replaces the live view.
  await page.getByRole("button", { name: "Abandon", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Confirm abandon" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole("timer")).toBeHidden();
});

test("a non-canonical task parameter opens nothing and the canonical list still renders", async ({ page }) => {
  await page.goto("/neuralflow/work?view=list&task=task-architecture");
  await waitSettled(page);
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start a focus session" })).toHaveCount(0);
});

test("the stone wall shows all 200 stones, a stone's card, and refuses a purchase the balance cannot cover", async ({
  page,
}) => {
  await page.goto("/learn/stones");
  await waitSettled(page);
  const content = page.locator("#content").first();
  await expect(content.getByRole("heading", { name: "Stones", level: 1 })).toBeVisible();
  await expect(content.getByRole("progressbar", { name: "Stones collected" })).toHaveAttribute("aria-valuemax", "200");
  // Diamond is the top of the set; no shared dev workspace earns its price in a test run.
  await content.getByRole("button", { name: /^Diamond/ }).click();
  const card = page.getByRole("dialog");
  await expect(card.getByRole("heading", { name: "Diamond" })).toBeVisible();
  await expect(card.getByText("10 on the Mohs scale")).toBeVisible();
  await expect(card.getByText("Folklore")).toBeVisible();
  await expect(card.getByRole("button", { name: /Buy for 1,500/ })).toBeDisabled();
});
