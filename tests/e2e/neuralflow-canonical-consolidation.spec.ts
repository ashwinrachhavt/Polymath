import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

test("canonical Work captures, clarifies, and presents the same work across working views", async ({ page }) => {
  await page.goto("/neuralflow/work");
  await waitSettled(page);
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  await expect(page.getByText(/Browser-only preview\. Sample records/)).toBeVisible();
  await page.getByRole("textbox", { name: "Quick task title" }).fill("Canonical work: prepare the review");
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Canonical work: prepare the review", exact: true })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Task queue", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Canonical work: prepare the review", exact: true }).click();
  const inspector = page.getByRole("dialog");
  await inspector.getByRole("combobox", { name: "Status" }).selectOption("READY");
  await inspector.getByLabel("Tags (comma-separated)").fill("Review, Planning");
  await inspector.getByRole("button", { name: "Save task locally" }).click();

  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.getByRole("button", { name: "Canonical work: prepare the review", exact: true })).toBeVisible();
  await expect(page.getByText("#Review", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "Board", exact: true }).click();
  await page.getByLabel("Move Canonical work: prepare the review to status").selectOption("IN_PROGRESS");
  await expect(page.getByText(/^\d+ tasks? in view$/)).toBeVisible();
  await expect(page.getByText(/\b1 tasks\b/)).toHaveCount(0);
  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "List", exact: true }).click();
  // Board tiles share the task's accessible name; open the inspector only once List has replaced Board.
  await expect(page.getByRole("heading", { name: "Task queue", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Canonical work: prepare the review", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "Status" })).toHaveValue("IN_PROGRESS");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("navigation", { name: "Work views" }).getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "View" }).selectOption("day");
  await expect(page.getByRole("button", { name: "Previous day", exact: true })).toBeEnabled();
  await expect(page.getByRole("navigation", { name: "NeuralFlow tools" }).getByRole("link", { name: "Stone collection" })).toHaveAttribute("href", "/apps/neuralflow/rewards");
});

test("canonical task deep links open the inspector and Focus retains its actual session across navigation", async ({ page }) => {
  await page.goto("/neuralflow/work?task=task-architecture");
  await waitSettled(page);
  await expect(page.getByRole("dialog", { name: "Task inspector" })).toBeVisible();
  await page.getByRole("dialog").getByRole("link", { name: "Focus on this task" }).click();
  await expect(page).toHaveURL(/\/neuralflow\/focus\?task=task-architecture/);
  await page.getByRole("button", { name: "Start interval", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("link", { name: "Back to Work", exact: true }).click();
  await page.getByRole("navigation", { name: "NeuralFlow tools" }).getByRole("link", { name: "Focus", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "End early", exact: true }).click();
  await page.getByRole("button", { name: "Save outcome and end locally", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start interval", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Stone collection", exact: true }).last()).toHaveAttribute("href", "/apps/neuralflow/rewards");
});

test("a task deep link opens a controlled inspector and closing it clears only the task parameter", async ({ page }) => {
  await page.goto("/neuralflow/work?view=list&task=task-architecture");
  await waitSettled(page);
  await expect(page.getByRole("dialog", { name: "Task inspector" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Inspect / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Task inspector" })).toBeHidden();
  await expect(page).toHaveURL(/\/neuralflow\/work\?view=list$/);
  await expect(page.locator('[data-task-trigger="task-architecture"]')).toBeFocused();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Task queue", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Task inspector" })).toHaveCount(0);
});

test("the stone collection shows the NeuralFlow catalog without unlocking stones the ledger has not earned", async ({ page }) => {
  await page.goto("/apps/neuralflow/rewards");
  await waitSettled(page);
  await expect(page.getByText("Quartz of Clarity; common", { exact: true })).toBeVisible();
  await expect(page.getByText("No earning rule yet", { exact: true })).toHaveCount(6);
  await page.getByRole("button", { name: /Diamond of Mastery/ }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "Diamond of Mastery, locked" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Collection filter" }).selectOption("earned");
  await expect(page.getByText("No earned stones yet", { exact: true })).toBeVisible();
});
