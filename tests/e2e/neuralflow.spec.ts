import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { waitSettled } from "./helpers/settled";

/** Direct SQL for the ledger assertion, the way learn-loop.spec.ts reads Neon: null when no DATABASE_URL is set. */
function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

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
  await expect
    .poll(
      async () =>
        (await preview(page)).tasks.find((task: { title: string }) => task.title === "Parity task: review a commitment")
          ?.status,
    )
    .toBe("IN_PROGRESS");
  await page.reload();
  await expect(page.getByLabel("Move Parity task: review a commitment to status")).toHaveValue("IN_PROGRESS");
  const state = await preview(page);
  expect(
    state.tasks.filter((task: { title: string }) => task.title === "Parity task: review a commitment"),
  ).toHaveLength(1);
});

test("literal brain dump proposals retain source and scheduler accepts local blocks only once", async ({ page }) => {
  await page.goto("/apps/neuralflow/brain-dump");
  await page
    .getByLabel("What's on your mind?")
    .fill("- Prepare a bounded review\n- Write the findings\n- Prepare a bounded review");
  await page.getByRole("button", { name: "Prepare local plan (not AI)" }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Accept 2 tasks locally" }).click();
  const state = await preview(page);
  expect(state.tasks.filter((task: { tags: string[] }) => task.tags.includes("Brain dump"))).toHaveLength(2);
  expect(state.captures.some((capture: { text: string }) => capture.text.includes("Prepare a bounded review"))).toBe(
    true,
  );
  expect(
    state.artifacts.some(
      (note: { title: string; links: string[] }) =>
        note.title === "Brain dump: accepted local plan" && note.links.length === 2,
    ),
  ).toBe(true);
  // The scheduler only proposes blocks for Ready and In progress tasks, so
  // promote both accepted captures through the same inspector flow test 1 uses.
  await page.goto("/apps/neuralflow/tasks");
  for (const title of ["Prepare a bounded review", "Write the findings"]) {
    await page.getByRole("button", { name: title, exact: true }).first().click();
    const inspector = page.getByRole("dialog");
    await inspector.getByRole("combobox", { name: "Status" }).selectOption("READY");
    await inspector.getByRole("button", { name: "Save task locally" }).click();
  }
  await page.goto("/apps/neuralflow/scheduler");
  // The hydration snapshot swap can remount the controlled input under the
  // fill, so one fill reverts to today even with a hydration wait. Refill
  // until the value sticks instead of assuming one fill landed post-hydration.
  const planningDate = page.getByLabel("Planning date");
  await expect
    .poll(
      async () => {
        if ((await planningDate.inputValue()) !== "2026-10-12") await planningDate.fill("2026-10-12");
        return (await planningDate.inputValue()) === "2026-10-12";
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Prepare local proposals" }).click();
  const accept = page.getByRole("button", { name: /^Accept \d+ local blocks$/ });
  await expect(accept).toBeEnabled();
  await accept.click();
  // The controlled date input is re-initialized when React hydrates, so a
  // fill that lands before hydration reverts to today and the proposal is
  // prepared for the wrong day. Poll the store instead of reading it once.
  await expect
    .poll(
      async () => (await preview(page)).events.filter((event: { date: string }) => event.date === "2026-10-12").length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const accepted = (await preview(page)).events.filter((event: { date: string }) => event.date === "2026-10-12");
  expect(accepted.every((event: { provider: string }) => event.provider === "local")).toBe(true);
  await page.getByRole("button", { name: "Refresh local proposals" }).click();
  await expect(page.getByText("No remaining proposals", { exact: true })).toBeVisible();
  expect((await preview(page)).events.filter((event: { date: string }) => event.date === "2026-10-12")).toHaveLength(
    accepted.length,
  );
});

test("a focus session starts from the task's Focus action on Work, and no stone is earned without a completed task: the Quartz rule fires on task completion, not focus", async ({
  page,
}) => {
  // Focus Mode is its own screen: the task detail's Focus action starts a
  // task-linked session and lands on Focus, where the live session's
  // controls render and the summary records what the session produced.
  // The closing assertion reads this session's own ledger rows in Neon, so
  // the test needs the same database the server runs on. Skipped loudly when
  // there is none (learn-loop.spec.ts's pattern) - never a silent pass.
  const client = db();
  test.skip(!client, "DATABASE_URL not configured (server and test).");
  const title = `Focus leg task ${Date.now().toString(36)}`;
  await page.goto("/neuralflow/work?view=saved");
  await waitSettled(page);
  await page.getByLabel("New task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  // A new task ranks to the end of the list, which on a long-lived workspace
  // is past the first page; the search filter narrows the view to the row.
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
  // The debounced search narrows the view to the new row.
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/task=[0-9a-f-]{36}/);
  const taskId = new URL(page.url()).searchParams.get("task")!;
  await expect(page.getByText("Focus history", { exact: true })).toBeVisible();
  await expect(page.getByText("No focus sessions against this task yet.", { exact: true })).toBeVisible();
  // The Focus action starts a task-linked session and lands on the Focus
  // screen, where the live controls render.
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await page.waitForURL(/\/neuralflow\/focus$/);
  await expect(page.getByText("Focusing", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("Focusing", { exact: true })).toBeVisible();
  // Pause again before finishing: a finish banks the open stretch, and the
  // point rule rounds any positive banked time up to a full unit (spec §5).
  // The premise of the final assertion - the flow earns nothing - holds only
  // for a finish with nothing banked, which is exactly what a paused finish
  // is ("from paused, nothing is open"). Without this, the seconds between
  // Resume and Finish decide the test: fast runners bank zero, slow ones
  // bank one second and pay a full unit - a timing flake, not an award bug.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  // A task-linked finish records the handoff against the task.
  await page.getByLabel("What changed? (saved against the task)").fill("Drafted the outline");
  await page.getByLabel("Next step (where you resume)").fill("Section two");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  // The summary reads the closed session's record, the handoff note included.
  await expect(page.getByText("Drafted the outline", { exact: true })).toBeVisible();
  // The focus address is the screen itself now, stale queries included.
  await page.goto("/neuralflow/focus?stale=param");
  await expect(page.getByText("Drafted the outline", { exact: true })).toBeVisible();
  // The task's focus history picked up the finished session.
  await page.goto("/neuralflow/work?view=saved");
  await waitSettled(page);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill(title);
  await page.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/task=[0-9a-f-]{36}/);
  await expect(page.getByText("No focus sessions against this task yet.", { exact: true })).toBeHidden();
  // The session finished, the task is still open: the Quartz rule awarded
  // nothing. The assertion is session-scoped (ASH-333), not the global
  // balance: the dev database's ledger is shared with the parallel suite, so
  // any worker finishing a task between a before-read and an after-read
  // moved the global number without this flow doing anything - the flake a
  // whole-balance equality baked in. Read the Quartz rule's own subject
  // instead: this flow's task must hold no task-completion award row.
  try {
    // Both ids are proven present before the zero-row read, so an empty
    // result is the rule holding, not a lookup that found nothing to check:
    // the task came from the detail URL, and the session row must exist.
    // The subjects match the award writes exactly (gamification/commands.ts:
    // quartz rows carry subjectType "task" + the task id, focus rows carry
    // subjectType "focus_session" + the session id).
    const [session] = await client!<{ id: string }[]>`
      select id from focus_sessions where task_id = ${taskId} order by started_at desc limit 1`;
    expect(session, "the finished focus session is recorded against the task").toBeTruthy();
    // Only the task-completion (Quartz) write is under test: its row carries
    // subjectType "task" + the task id (gamification/commands.ts). The
    // session's own focus_completed points row (subjectType "focus_session")
    // is legitimate pay for banked seconds and must NOT fail this test -
    // whether a fast run banks a whole second is exactly the remaining flake
    // the subject pair baked in (CI run 42174835562 attempt 1 vs retry).
    const awarded = await client!<{ id: string }[]>`
      select id from reward_ledger
      where subject_type = 'task' and subject_id = ${taskId}`;
    expect(awarded, "a focus session with an open task earns no task-completion award").toHaveLength(0);
  } finally {
    await client!.end();
  }
  // The rewards surface still renders the readout this flow left untouched.
  await page.goto("/apps/neuralflow/rewards");
  await expect(page.locator("p", { hasText: "Points earned" }).locator("+ .readout")).toBeVisible();
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
  expect(meeting).toMatchObject({
    type: "Meeting",
    provider: "local",
    duration: 60,
    endDate: "2026-10-12",
    location: "Local preview room",
    tags: ["Review", "Planning"],
  });
  expect(state.artifacts.find((note: { id: string }) => note.id === meeting.notesArtifactId)).toMatchObject({
    kind: "note",
    body: "A manually recorded meeting note.",
    links: [meeting.id],
  });
  await page.goto("/apps/neuralflow/calendar?date=2026-10-12");
  await page.getByRole("combobox", { name: "View" }).selectOption("day");
  await expect(page.getByText("Overnight local review", { exact: true })).toBeVisible();
});

test("a canonical rich note saves an immutable local revision and shared task link", async ({ page }) => {
  // The link target is created through the UI: the workspace boots empty.
  await page.goto("/apps/neuralflow/tasks");
  await page.getByRole("textbox", { name: "Quick task title" }).fill("Link target task");
  await page.getByRole("button", { name: "Capture task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Link target task", exact: true })).toBeVisible();
  await page.goto("/apps/neuralflow/notes");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Shared parity reflection");
  await dialog.getByLabel("Note body", { exact: true }).fill("Original owner note.");
  await dialog.getByRole("button", { name: "Create note locally" }).click();
  await page.getByRole("button", { name: "Shared parity reflection", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Rich note content" }).fill("Revised owner note.");
  await dialog.getByRole("checkbox", { name: "Task: Link target task", exact: true }).check();
  await dialog.getByRole("button", { name: "Save note locally" }).click();
  const state = await preview(page);
  const note = state.artifacts.find((artifact: { title: string }) => artifact.title === "Shared parity reflection");
  expect(note.body).toContain("Revised owner note.");
  const linkTarget = state.tasks.find((task: { title: string }) => task.title === "Link target task");
  expect(note.links).toContain(linkTarget.id);
  expect(
    state.artifactVersions.filter((version: { artifactId: string }) => version.artifactId === note.id).length,
  ).toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "Shared parity reflection", exact: true })).toBeVisible();
});
