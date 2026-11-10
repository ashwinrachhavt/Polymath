import { test, expect } from "@playwright/test";
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
  await page.goto("/neuralflow/rewards");
  await expect(page.locator("p", { hasText: "Points earned" }).locator("+ .readout")).toBeVisible();
});
