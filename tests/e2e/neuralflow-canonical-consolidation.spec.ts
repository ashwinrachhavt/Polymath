import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

test("every Work view reads the same canonical Neon task", async ({ page }) => {
  const title = `Canonical work ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=list");
  await waitSettled(page);
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
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
  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Previous week", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "More tools", exact: true }).getByRole("link", { name: "Stone collection" })).toHaveAttribute("href", "/apps/neuralflow/rewards");
});

test("a canonical task deep link opens its detail and starts a task-linked focus session", async ({ page }) => {
  const title = `Focus linked ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=saved");
  await waitSettled(page);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/neuralflow\/work\?view=saved&task=[0-9a-f-]{36}/);
  await page.getByRole("link", { name: "Start a focus session" }).click();
  await expect(page).toHaveURL(/\/neuralflow\/focus\?task=[0-9a-f-]{36}/);
  // The session is linked to the canonical task, not to pasted preview text.
  await expect(page.getByText(title).first()).toBeVisible();
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  // The server owns the session: it survives a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: /What changed/ }).fill("Drafted the outline");
  await page.getByRole("textbox", { name: /Next step/ }).fill("Fill in section two");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start focus", exact: true })).toBeVisible();
  // The resume record lands on the task's focus history.
  await page.goto("/neuralflow/work?view=saved");
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByText(/Drafted the outline/)).toBeVisible();
  await expect(page.getByText(/Fill in section two/)).toBeVisible();
});


test("a non-canonical task parameter opens nothing and the canonical list still renders", async ({ page }) => {
  await page.goto("/neuralflow/work?view=list&task=task-architecture");
  await waitSettled(page);
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start a focus session" })).toHaveCount(0);
});

test("the stone collection is the durable catalog: definitions are saved, and the ledger stays empty until a task completes", async ({ page }) => {
  await page.goto("/apps/neuralflow/rewards");
  await waitSettled(page);
  await expect(page.getByRole("heading", { name: "Stone collection", exact: true })).toBeVisible();
  await expect(page.getByText("Nothing earned yet", { exact: true })).toBeVisible();
  // Defining a catalog row changes no balances: the ledger stays empty.
  // The Field wrapper labels the kind <select> by its whole contents, so
  // label-text lookups for the inputs go through the textbox role instead.
  await page.getByRole("textbox", { name: "Key", exact: true }).fill("quartz");
  await page.getByRole("textbox", { name: "Label", exact: true }).fill("Quartz");
  await page.getByRole("textbox", { name: "Points", exact: true }).fill("10");
  await page.getByRole("button", { name: "Define reward", exact: true }).click();
  await expect(page.getByText("Quartz (quartz)", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing earned yet", { exact: true })).toBeVisible();
});
