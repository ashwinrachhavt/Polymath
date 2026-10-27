import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { insertTaskNote } from "./helpers/task-note";

/*
 * Pixels and journey for the weekly outcome narrative (ASH-280) on Reports:
 * a finished session with the owner's sentence and an earned stone become a
 * factual narrative; Keep saves it as a note, Discard writes nothing. No
 * model is involved, so there is nothing to mock and nothing to spend.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const OUTCOME = "Outlined the narrative card for the weekly review";
const TASK_TITLE = "E2E weekly narrative task";
const STONE_KEY = "e2e-narrative-stone";

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

async function seedWeek(): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    if (!owner) return false;
    const ws = owner.workspace_id;
    // Idempotent across viewport reruns: clear earlier seeds so the narrative
    // lists exactly one bullet (parallel-safe under the single CI worker).
    await client`delete from reward_ledger where idempotency_key like ${`${STONE_KEY}-%`}`;
    await client`delete from focus_sessions where outcome = ${OUTCOME}`;
    await client`delete from tasks where title = ${TASK_TITLE}`;
    await client`delete from artifacts where title = ${TASK_TITLE} and template = 'issue'`;
    // The session's task needs its note: every work read inner-joins it.
    const taskNote = await insertTaskNote(client, { workspaceId: ws, title: TASK_TITLE });
    const [task] = await client<{ id: string }[]>`
      insert into tasks (workspace_id, note_id, title, status)
      values (${ws}, ${taskNote}, ${TASK_TITLE}, 'ready') returning id`;
    await client`
      insert into focus_sessions (workspace_id, task_id, state, started_at, ended_at, accumulated_seconds, outcome)
      values (${ws}, ${task.id}, 'finished', now() - interval '25 minutes', now() - interval '1 minute', 1500, ${OUTCOME})`;
    const [def] = await client<{ id: string }[]>`
      insert into reward_definitions (workspace_id, key, kind, label, points)
      values (${ws}, ${STONE_KEY}, 'collectible', 'Quartz', 10)
      on conflict (workspace_id, key) do update set label = excluded.label returning id`;
    await client`
      insert into reward_ledger (workspace_id, reward_definition_id, reason, points, idempotency_key)
      values (${ws}, ${def.id}, 'task_completed', 10, ${`${STONE_KEY}-${Date.now()}`})`;
    return true;
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`delete from reward_ledger where idempotency_key like ${`${STONE_KEY}-%`}`;
    await client`delete from reward_definitions where key = ${STONE_KEY}`;
    await client`delete from focus_sessions where outcome = ${OUTCOME}`;
    await client`delete from tasks where title = ${TASK_TITLE}`;
    await client`delete from artifacts where title = ${TASK_TITLE} and template = 'issue'`;
    await client`delete from artifacts where kind = 'note' and title like 'Week of %' and id in (
      select artifact_id from artifact_versions where plain_text like ${`%${OUTCOME}%`})`;
  } finally {
    await client.end();
  }
}

async function narrativeNoteCount(): Promise<number> {
  const client = db();
  if (!client) return 0;
  try {
    const [row] = await client<{ n: number }[]>`
      select count(*)::int as n from artifact_versions where plain_text like ${`%${OUTCOME}%`}`;
    return row.n;
  } finally {
    await client.end();
  }
}

/*
 * The viewport journeys and the discard test share one account and constant
 * fixture keys (TASK_TITLE, STONE_KEY, OUTCOME): seedWeek deletes and
 * re-seeds those exact rows. Under fullyParallel the file's tests run in
 * separate workers against the shared database and each seed pass deletes
 * the other's fixture mid-journey - serial inside the file is the honest
 * shape for one shared account row set.
 */
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await removeSeeded();
});

for (const vp of VIEWPORTS) {
  test(`keep the weekly narrative as a note [${vp.name}]`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    test.skip(!(await seedWeek()), "DATABASE_URL not configured");
    await page.goto("/apps/neuralflow/reports");
    const panel = page.locator("section", { has: page.getByRole("heading", { name: /This week in your words/ }) });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(OUTCOME)).toHaveCount(1);
    await expect(panel.getByText(/earned \d+ stones?/)).toBeVisible();
    await expect(panel.getByText(/streak|points|score/i)).toHaveCount(0);
    const before = await narrativeNoteCount();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/feature-pixels/weekly-narrative-${vp.name}.png`, style: HIDE_DEV_CHROME });
    // Controls stay inside the viewport width on mobile (no clipped buttons).
    const keep = panel.getByRole("button", { name: "Keep as note" });
    const box = await keep.boundingBox();
    expect(box, "keep button has a box").not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
    expect(await narrativeNoteCount(), "viewing alone writes no note").toBe(before);

    await keep.click();
    await expect(panel.getByRole("link", { name: "Open note" })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Keep as note" })).toHaveCount(0);
    await page.screenshot({ path: `test-results/feature-pixels/weekly-narrative-kept-${vp.name}.png`, style: HIDE_DEV_CHROME });
    expect(await narrativeNoteCount()).toBe(before + 1);
    await panel.getByRole("link", { name: "Open note" }).click();
    await expect(page).toHaveURL(/\/alfred\/notes\?id=[0-9a-f-]{36}/);
  });
}

test("discard hides the narrative and writes no note", async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!(await seedWeek()), "DATABASE_URL not configured");
  await page.goto("/apps/neuralflow/reports");
  const heading = page.getByRole("heading", { name: /This week in your words/ });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  const before = await narrativeNoteCount();
  await page.getByRole("button", { name: "Hide for now" }).click();
  await expect(heading).toHaveCount(0);
  expect(await narrativeNoteCount()).toBe(before);
});
