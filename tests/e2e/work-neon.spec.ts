import { test, expect } from "@playwright/test";

/*
 * The Work list on Neon: what the owner does in one sitting, and that it is
 * still there after a reload (nothing here lives in browser storage).
 */

test("capture, commit, split, block, reorder and finish a task, saved in the workspace", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = `Plan launch ${tag}`;
  const b = `Write copy ${tag}`;
  await page.goto("/neuralflow/work?view=saved");
  await expect(page.getByText("Saved to your workspace.", { exact: true })).toBeVisible();

  for (const title of [a, b]) {
    await page.getByLabel("New task title").fill(title);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  }
  // Persisted: a reload reads Neon, not the browser.
  await page.reload();
  await expect(page.getByRole("link", { name: a, exact: true })).toBeVisible();
  const order = await page.getByRole("list").filter({ has: page.getByRole("link", { name: a, exact: true }) }).first().innerText();
  expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));

  // Reorder: move the first one down below the second.
  await page.getByRole("button", { name: `Move ${a} down` }).click();
  await expect
    .poll(async () => {
      const text = await page.getByRole("list").filter({ has: page.getByRole("link", { name: a, exact: true }) }).first().innerText();
      return text.indexOf(b) < text.indexOf(a);
    })
    .toBe(true);
  await page.reload();
  const after = await page.getByRole("list").filter({ has: page.getByRole("link", { name: a, exact: true }) }).first().innerText();
  expect(after.indexOf(b)).toBeLessThan(after.indexOf(a));

  // Commit it: Ready shows up under Today.
  await page.getByRole("link", { name: a, exact: true }).click();
  await page.getByRole("combobox", { name: "Status" }).selectOption("ready");
  await page.getByRole("combobox", { name: "Priority" }).selectOption("high");
  await page.getByRole("button", { name: "Save task" }).click();
  // The saved row comes back from the server with its new priority badge.
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("high", { exact: true })).toBeVisible();
  await page.goto("/neuralflow/work?view=saved&show=today");
  await expect(page.getByRole("link", { name: a, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);

  // Subtask and dependency on the card.
  await page.getByRole("link", { name: a, exact: true }).click();
  await page.getByLabel("New subtask title").fill(`Outline ${tag}`);
  await page.getByRole("button", { name: "Add subtask" }).click();
  await expect(page.getByText(`Outline ${tag}`)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("0/1 subtasks")).toBeVisible();

  await page.goto("/neuralflow/work?view=saved");
  await page.getByRole("link", { name: a, exact: true }).click();
  await page.getByLabel("Other task").selectOption({ label: b });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByText(`Blocked by ${b}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("Blocked by 1")).toBeVisible();

  // A cycle is refused with a message, not a crash.
  await page.getByRole("link", { name: b, exact: true }).click();
  await page.getByLabel("Other task").selectOption({ label: a });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByText("That dependency would make the tasks wait on each other.")).toBeVisible();

  // Finishing the blocker releases the other task.
  await page.getByRole("button", { name: `Complete ${b}` }).click();
  await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("Blocked by 1")).toHaveCount(0);
  await page.goto("/neuralflow/work?view=saved&show=done");
  await expect(page.getByRole("link", { name: b, exact: true })).toBeVisible();
});
