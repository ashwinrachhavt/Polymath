import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for meeting prep (ASH-302): the Prep control on Today's Flow and
 * the whole journey - click, report linked, report readable - against the
 * free fixture provider (GENERATION_PROVIDER=fixture). No model key, no
 * spend. Screenshots upload as the feature-pixels CI artifact.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

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

const EVENT_TITLE = "Weekly sync";
const NOTE_TITLE = "Pricing decision";
const TASK_TITLE = "Send the Q3 roadmap to Priya Nair";

/** The event, its attendee+contact, the mentioning note and the open loop. */
async function seedPrepContext(): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return false;
    const ws = owner.workspace_id;
    const uid = owner.user_id;

    const [calendar] = await client<{ id: string }[]>`
      insert into calendars (workspace_id, kind, name, created_by, updated_by)
      values (${ws}, 'local', 'E2E Prep Calendar', ${uid}, ${uid})
      returning id`;
    const startsAt = new Date(Date.now() + 2 * 3_600_000);
    const endsAt = new Date(Date.now() + 3 * 3_600_000);
    const [event] = await client<{ id: string }[]>`
      insert into events (workspace_id, calendar_id, title, starts_at, ends_at, created_by, updated_by)
      values (${ws}, ${calendar.id}, ${EVENT_TITLE}, ${startsAt}, ${endsAt}, ${uid}, ${uid})
      returning id`;
    const [contact] = await client<{ id: string }[]>`
      insert into contacts (workspace_id, full_name, primary_email, title, created_by, updated_by)
      values (${ws}, 'Priya Nair', 'priya@example.com', 'Platform lead', ${uid}, ${uid})
      returning id`;
    await client`
      insert into event_attendees (workspace_id, event_id, email, display_name, contact_id)
      values (${ws}, ${event.id}, 'priya@example.com', 'Priya Nair', ${contact.id})`;
    const [note] = await client<{ id: string }[]>`
      insert into artifacts (workspace_id, kind, title, status, created_by, updated_by)
      values (${ws}, 'note', ${NOTE_TITLE}, 'reviewed', ${uid}, ${uid})
      returning id`;
    const [version] = await client<{ id: string }[]>`
      insert into artifact_versions (workspace_id, artifact_id, version_number, content, plain_text, reason, created_by)
      values (${ws}, ${note.id}, 1, '{"type":"doc","content":[]}'::jsonb,
        ${"Decided with Priya Nair: annual billing stays for the platform tier."}, 'created', ${uid})
      returning id`;
    await client`update artifacts set current_version_id = ${version.id} where id = ${note.id}`;
    await client`
      insert into tasks (workspace_id, title, status, created_by, updated_by)
      values (${ws}, ${TASK_TITLE}, 'ready', ${uid}, ${uid})`;
    return true;
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`delete from events where title = ${EVENT_TITLE}`;
    await client`delete from calendars where name = 'E2E Prep Calendar'`;
    await client`delete from contacts where primary_email = 'priya@example.com'`;
    await client`delete from artifacts where title in (${NOTE_TITLE}, 'Prep: Weekly sync')`;
    await client`delete from tasks where title = ${TASK_TITLE}`;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

for (const vp of VIEWPORTS) {
  test(`generate a prep report from an event [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    test.skip(!(await seedPrepContext()), "DATABASE_URL not configured");

    await page.goto("/neuralflow/work");
    const row = page.locator("li", { hasText: EVENT_TITLE }).first();
    await expect(row.getByRole("button", { name: "Prep" })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/prep-button-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await row.getByRole("button", { name: "Prep" }).click();
    await expect(row.getByRole("link", { name: "Prep ready" })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `test-results/feature-pixels/prep-ready-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await row.getByRole("link", { name: "Prep ready" }).click();
    await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByText("Confirm the launch date")).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/prep-report-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });
}
