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

test("a focus session starts from the task's Focus action on Work, and no coins are paid without a completed task: focus sessions do not pay", async ({
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
  // The session finished, the task is still open: no coins. Read this flow's
  // own rows (the dev ledger is shared with the parallel suite): neither the
  // task nor the session may hold a coin row.
  try {
    const [session] = await client!<{ id: string }[]>`
      select id from focus_sessions where task_id = ${taskId} order by started_at desc limit 1`;
    expect(session, "the finished focus session is recorded against the task").toBeTruthy();
    const awarded = await client!<{ id: string }[]>`
      select id from coin_ledger where subject_id in (${taskId}, ${session.id})`;
    expect(awarded, "a focus session pays no coins, and an open task pays none").toHaveLength(0);
  } finally {
    await client!.end();
  }
});
