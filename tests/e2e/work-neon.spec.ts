import { test, expect, type Locator, type Page } from "@playwright/test";

/*
 * The Work list on Neon: what the owner does in one sitting, and that it is
 * still there after a reload (nothing here lives in browser storage).
 *
 * Ordering assertions compare the two tagged cards' positions directly
 * (bounding boxes), never text indices over the whole board: the workspace is
 * shared with the parallel suite, so a whole-board innerText can miss a card
 * entirely (-1 comparisons silently pass or fail on suite leftovers, ASH-321).
 */

/** Vertical order of two visible cards: is `upper` rendered above `lower`? */
async function isAbove(upper: Locator, lower: Locator): Promise<boolean> {
  const [up, low] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
  if (!up || !low) return false;
  return up.y + up.height / 2 < low.y + low.height / 2;
}

/**
 * A new task ranks to the end of the global order, which on a long-lived
 * workspace sits past the first page. Narrow the list to the tagged rows
 * through the list's own search instead of assuming page one holds them.
 */
async function narrowTo(page: Page, tag: string): Promise<void> {
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(tag);
}

/** The saved-list scope holding both tagged rows, with both rendered. */
function savedRows(page: Page, a: string, b: string): { linkA: Locator; linkB: Locator } {
  const list = page.getByRole("list").filter({ has: page.getByRole("link", { name: a, exact: true }) }).first();
  return { linkA: list.getByRole("link", { name: a, exact: true }), linkB: list.getByRole("link", { name: b, exact: true }) };
}

test("capture, commit, split, block, reorder and finish a task, saved in the workspace", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = `Plan launch ${tag}`;
  const b = `Write copy ${tag}`;
  await page.goto("/neuralflow/work?view=saved");
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  // A new task ranks to the end of the global order, which on a long-lived
  // workspace sits past the first page. Narrow the list to this test's rows
  // through the list's own search rather than assuming page one holds them.
  await narrowTo(page, tag);

  for (const title of [a, b]) {
    await page.getByLabel("New task title").fill(title);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  }
  // Persisted: a reload reads Neon, not the browser.
  await page.reload();
  await expect(page.getByRole("link", { name: a, exact: true })).toBeVisible();
  const created = savedRows(page, a, b);
  await expect(created.linkA).toBeVisible();
  await expect(created.linkB).toBeVisible();
  expect(await isAbove(created.linkA, created.linkB)).toBe(true);

  // Reorder: the board's lane cards own reordering since the Work redesign.
  // The lane text flipping means the server action committed; navigating away
  // sooner can abort it and read the pre-move rows back.
  await page.goto("/neuralflow/work?view=board");
  await page.getByRole("button", { name: `Move ${a} down` }).click();
  // The poll only passes once BOTH cards render and b sits above a: a missing
  // card yields a null box and keeps waiting instead of misreading leftovers.
  // The budget is 30s, not the 5s default: the reorder commits through a
  // server action and the board re-renders with its refreshed RSC stream,
  // which under parallel-suite load has exceeded 5s in CI (run 40391648464).
  const cardA = page.getByText(a, { exact: true });
  const cardB = page.getByText(b, { exact: true });
  await expect.poll(() => isAbove(cardB, cardA), { timeout: 30_000 }).toBe(true);
  await page.goto("/neuralflow/work?view=saved");
  await narrowTo(page, tag);
  await expect(page.getByRole("button", { name: `Done: complete ${b}` })).toBeEnabled();
  await page.reload();
  const moved = savedRows(page, a, b);
  await expect(moved.linkA).toBeVisible();
  await expect(moved.linkB).toBeVisible();
  expect(await isAbove(moved.linkB, moved.linkA)).toBe(true);

  // Commit it: Ready shows up under Today.
  await page.getByRole("link", { name: a, exact: true }).click();
  await page.getByRole("combobox", { name: "Status" }).selectOption("ready");
  await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Save task" }).click();
  // The saved row comes back from the server with its new priority badge.
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("high", { exact: true })).toBeVisible();
  await page.goto("/neuralflow/work?view=saved&show=today");
  // Today can hold more than one page on a long-lived workspace, and the new
  // task ranks to the end, so narrow before asserting it is on screen.
  await narrowTo(page, tag);
  await expect(page.getByRole("link", { name: a, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);

  // Subtask and dependency on the card. Selecting a row is a navigation, so
  // wait for the inspector to commit before typing into its form: filling
  // during the transition loses the value when the panel re-renders.
  await page.getByRole("link", { name: a, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(a);
  await page.getByLabel("New subtask title").fill(`Outline ${tag}`);
  await page.getByRole("button", { name: "Add subtask" }).click();
  await expect(page.getByText(`Outline ${tag}`)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("0/1", { exact: true })).toBeVisible();

  await page.goto("/neuralflow/work?view=saved");
  await narrowTo(page, tag);
  await page.getByRole("link", { name: a, exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).waitFor();
  await page.getByLabel("Other task").selectOption({ label: b });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByText(`Blocked by ${b}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("Blocked by 1")).toBeVisible();

  // A cycle is refused with a message, not a crash.
  await page.getByRole("link", { name: b, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(b);
  await page.getByLabel("Other task").selectOption({ label: a });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByText("That dependency would make the tasks wait on each other.")).toBeVisible();

  // Finishing the blocker releases the other task.
  // Done opens the completion-sentence form; "Just complete" finishes with no sentence.
  await page.getByRole("button", { name: `Done: complete ${b}` }).click();
  await page.getByRole("button", { name: "Just complete" }).click();
  await expect(page.getByRole("link", { name: b, exact: true })).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("Blocked by 1")).toHaveCount(0);
  await page.goto("/neuralflow/work?view=saved&show=done");
  await expect(page.getByRole("link", { name: b, exact: true })).toBeVisible();
});

test("board lanes and the calendar show the same saved rows", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = `Board lane ${tag}`;
  const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow, UTC

  await page.goto("/neuralflow/work?view=saved");
  await narrowTo(page, tag);
  await page.getByLabel("New task title").fill(a);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: a, exact: true })).toBeVisible();

  // Give it a status and a due date on the card.
  await page.getByRole("link", { name: a, exact: true }).click();
  await page.getByRole("combobox", { name: "Status" }).selectOption("in_progress");
  await page.getByLabel("Due").fill(due);
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: a }).getByText("In progress", { exact: true })).toBeVisible();

  // The board files it under In progress, and a lane move saves a new status.
  await page.goto("/neuralflow/work?view=board");
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
  const lane = page.getByRole("heading", { name: "In progress", exact: true }).locator("..").locator("..").locator("..");
  await expect(lane.getByText(a, { exact: true })).toBeVisible();
  await page.getByLabel(`Move ${a} to status`).selectOption("waiting");
  // The board refreshes in place when the save lands. Reloading before that
  // aborts the in-flight action, so wait for the move first, then confirm the
  // saved row survives a reload.
  const waitingLane = page.getByRole("heading", { name: "Waiting", exact: true }).locator("..").locator("..").locator("..");
  await expect(waitingLane.getByText(a, { exact: true })).toBeVisible();
  await page.reload();
  await expect(waitingLane.getByText(a, { exact: true })).toBeVisible();

  // The calendar places it on its due day.
  await page.goto(`/neuralflow/work?view=calendar&date=${due}`);
  // The week grid lists it under "Needs a time block" until it has a block.
  await expect(page.getByRole("link", { name: a, exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Work views", exact: true })).toBeVisible();
});
