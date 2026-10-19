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
  // The deep link prefills the subject; starting commits the session to
  // Postgres, so the controls below are the durable lifecycle's, and the
  // session survives navigation and reload because the server owns the clock.
  await expect(page.getByLabel("Focusing on")).toHaveValue("task-architecture");
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to Work", exact: true }).click();
  await page.getByRole("navigation", { name: "NeuralFlow tools" }).getByRole("link", { name: "Focus", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start focus", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Stone collection", exact: true }).last()).toHaveAttribute("href", "/apps/neuralflow/rewards");
});
