import { test, expect, type Page } from "@playwright/test";

async function preview(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("axiom-ui-preview-v1") || "{}"));
}

test("NeuralFlow captures and edits one task then moves the same task with the keyboard board", async ({ page }) => {
  await page.goto("/apps/neuralflow/tasks");
  await page.getByRole("textbox", { name: "Quick task title" }).fill("Parity task: review a commitment");
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await page.getByRole("button", { name: "Parity task: review a commitment", exact: true }).click();
  const inspector = page.getByRole("dialog");
  // Field wraps the control in a <label>, whose accessible name includes the
  // option text, so exact getByLabel never matches. Role + name is the stable locator.
  await inspector.getByRole("combobox", { name: "Status" }).selectOption("READY");
  await inspector.getByRole("combobox", { name: "Priority" }).selectOption("High");
  await inspector.getByLabel("Estimate (minutes)").fill("30");
  await inspector.getByRole("button", { name: "Save task locally" }).click();
  await page.goto("/apps/neuralflow/boards");
  const tile = page.getByRole("button", { name: "Parity task: review a commitment", exact: true });
  await tile.focus();
  await tile.press("Alt+ArrowRight");
  await expect.poll(async () => (await preview(page)).tasks.find((task: { title: string }) => task.title === "Parity task: review a commitment")?.status).toBe("IN_PROGRESS");
  await page.reload();
  await expect(page.getByLabel("Move Parity task: review a commitment to status")).toHaveValue("IN_PROGRESS");
  const state = await preview(page);
  expect(state.tasks.filter((task: { title: string }) => task.title === "Parity task: review a commitment")).toHaveLength(1);
});

test("literal brain dump proposals retain source and scheduler accepts local blocks only once", async ({ page }) => {
  await page.goto("/apps/neuralflow/brain-dump");
  await page.getByLabel("What's on your mind?").fill("- Prepare a bounded review\n- Write the findings\n- Prepare a bounded review");
  await page.getByRole("button", { name: "Prepare local plan (not AI)" }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Accept 2 tasks locally" }).click();
  const state = await preview(page);
  expect(state.tasks.filter((task: { tags: string[] }) => task.tags.includes("Brain dump"))).toHaveLength(2);
  expect(state.captures.some((capture: { text: string }) => capture.text.includes("Prepare a bounded review"))).toBe(true);
  expect(state.artifacts.some((note: { title: string; links: string[] }) => note.title === "Brain dump: accepted local plan" && note.links.length === 2)).toBe(true);
  await page.goto("/apps/neuralflow/scheduler");
  // The hydration snapshot swap can remount the controlled input under the
  // fill, so one fill reverts to today even with a hydration wait. Refill
  // until the value sticks instead of assuming one fill landed post-hydration.
  const planningDate = page.getByLabel("Planning date");
  await expect.poll(async () => {
    if ((await planningDate.inputValue()) !== "2026-10-12") await planningDate.fill("2026-10-12");
    return (await planningDate.inputValue()) === "2026-10-12";
  }, { timeout: 10_000 }).toBe(true);
  await page.getByRole("button", { name: "Prepare local proposals" }).click();
  const accept = page.getByRole("button", { name: /^Accept \d+ local blocks$/ });
  await expect(accept).toBeEnabled();
  await accept.click();
  // The controlled date input is re-initialized when React hydrates, so a
  // fill that lands before hydration reverts to today and the proposal is
  // prepared for the wrong day. Poll the store instead of reading it once.
  await expect.poll(async () => (await preview(page)).events.filter((event: { date: string }) => event.date === "2026-10-12").length, { timeout: 10_000 }).toBeGreaterThan(0);
  const accepted = (await preview(page)).events.filter((event: { date: string }) => event.date === "2026-10-12");
  expect(accepted.every((event: { provider: string }) => event.provider === "local")).toBe(true);
  await page.getByRole("button", { name: "Refresh local proposals" }).click();
  await expect(page.getByText("No remaining proposals", { exact: true })).toBeVisible();
  expect((await preview(page)).events.filter((event: { date: string }) => event.date === "2026-10-12")).toHaveLength(accepted.length);
});

test("focus survives navigation and pause, then records one outcome and one idempotent stone", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-11T12:00:00") });
  await page.goto("/apps/neuralflow/focus?task=task-architecture");
  await page.getByLabel("Duration (minutes)").fill("1");
  await page.getByRole("button", { name: "Start interval", exact: true }).click();
  await page.clock.fastForward(10000);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = (await preview(page)).focus.remaining;
  await page.goto("/apps/neuralflow/tasks");
  await page.clock.fastForward(120000);
  await page.goto("/apps/neuralflow/focus");
  expect((await preview(page)).focus.remaining).toBe(paused);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.clock.fastForward(61000);
  await expect.poll(async () => (await preview(page)).focus.remaining).toBe(0);
  await page.getByRole("button", { name: "Review outcome", exact: true }).click();
  await page.getByLabel("What changed? (optional)").fill("Recorded an explicit decision.");
  await page.getByRole("button", { name: "Save outcome and end locally" }).click();
  await expect.poll(async () => (await preview(page)).rewards.length).toBe(1);
  const state = await preview(page);
  expect(state.focus).toBeNull();
  expect(state.artifacts.some((note: { body: string; links: string[] }) => note.body.includes("Recorded an explicit decision") && note.links.includes("task-architecture"))).toBe(true);
  await page.reload();
  expect((await preview(page)).rewards).toHaveLength(1);
  await page.goto("/apps/neuralflow/rewards");
  await expect(page.getByText("Earned: 1", { exact: true })).toBeVisible();
});

test("a local overnight meeting retains full metadata and uses canonical event notes", async ({ page }) => {
  await page.goto("/apps/neuralflow/meetings");
  await page.getByRole("button", { name: "New local meeting", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Block title").fill("Overnight local review");
  await dialog.getByLabel("Starts (browser local)").fill("2026-10-11T23:30");
  await dialog.getByLabel("Ends (browser local)").fill("2026-10-12T00:30");
  await dialog.getByLabel("Location", { exact: true }).fill("Local preview room");
  await dialog.getByLabel("Tags (comma-separated)").fill("Review, Planning");
  await dialog.getByLabel("Canonical event notes").fill("A manually recorded meeting note.");
  await dialog.getByRole("button", { name: "Save block locally" }).click();
  await expect(page.getByRole("heading", { name: "Overnight local review", exact: true })).toBeVisible();
  const state = await preview(page);
  const meeting = state.events.find((event: { title: string }) => event.title === "Overnight local review");
  expect(meeting).toMatchObject({ type: "Meeting", provider: "local", duration: 60, endDate: "2026-10-12", location: "Local preview room", tags: ["Review", "Planning"] });
  expect(state.artifacts.find((note: { id: string }) => note.id === meeting.notesArtifactId)).toMatchObject({ kind: "note", body: "A manually recorded meeting note.", links: [meeting.id] });
  await page.goto("/apps/neuralflow/calendar?date=2026-10-12");
  await page.getByRole("combobox", { name: "View" }).selectOption("day");
  await expect(page.getByText("Overnight local review", { exact: true })).toBeVisible();
});

test("a canonical rich note saves an immutable local revision and shared task link", async ({ page }) => {
  await page.goto("/apps/neuralflow/notes");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Shared parity reflection");
  await dialog.getByLabel("Note body", { exact: true }).fill("Original owner note.");
  await dialog.getByRole("button", { name: "Create note locally" }).click();
  await page.getByRole("button", { name: "Shared parity reflection", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Rich note content" }).fill("Revised owner note.");
  await dialog.getByRole("checkbox", { name: "Task: Review the canonical Axiom data model", exact: true }).check();
  await dialog.getByRole("button", { name: "Save note locally" }).click();
  const state = await preview(page);
  const note = state.artifacts.find((artifact: { title: string }) => artifact.title === "Shared parity reflection");
  expect(note.body).toContain("Revised owner note.");
  expect(note.links).toContain("task-architecture");
  expect(state.artifactVersions.filter((version: { artifactId: string }) => version.artifactId === note.id).length).toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "Shared parity reflection", exact: true })).toBeVisible();
});
