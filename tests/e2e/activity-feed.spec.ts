import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * The Activity rail reads the workspace's real audit events - the read
 * surface recordAudit never had while the rail rendered the browser-local
 * preview log. One journey writes a real event through the calendar's
 * add-block action (the same recordAudit path every domain uses) and reads
 * it back on /activity; a second pins workspace isolation.
 */
function db() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

test("an audit event written by a real action lands on the activity rail", async ({ page }) => {
  test.setTimeout(120_000);
  const client = db();
  const tag = `activity-e2e-${Date.now().toString(36)}`;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");

    await page.goto("/neuralflow/work?view=calendar");
    await page.getByRole("button", { name: "+ Add block" }).click();
    await page.locator('input[name="title"]').fill(tag);
    const today = new Date().toISOString().slice(0, 10);
    await page.locator('input[name="day"]').fill(today);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    // The form closes only after the server action commits.
    await expect(page.locator('input[name="title"]')).toBeHidden();

    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText(`Created event "${tag}"`)).toBeVisible();
  } finally {
    if (client) {
      await client`delete from events where title = ${tag}`;
      await client`delete from audit_events where summary like ${"%" + tag + "%"}`;
      await client.end();
    }
  }
});

test("the activity rail never shows another workspace's events", async ({ page }) => {
  test.setTimeout(60_000);
  const client = db();
  const tag = `foreign-activity-${Date.now().toString(36)}`;
  let seededId: string | null = null;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    const [owner] = await client!<{ workspace_id: string }[]>`
      select m.workspace_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    test.skip(!owner, "dev workspace not found");
    const [other] = await client!<{ id: string }[]>`
      select id from workspaces where id <> ${owner!.workspace_id} limit 1`;
    test.skip(!other, "no second workspace to seed foreign activity into");
    const [row] = await client!<{ id: string }[]>`
      insert into audit_events (workspace_id, actor_kind, action, subject_type, summary)
      values (${other!.id}, 'user', 'capture.created', 'capture', ${`Foreign event ${tag}`})
      returning id`;
    seededId = row!.id;

    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText(`Foreign event ${tag}`)).toHaveCount(0);
  } finally {
    if (client && seededId) await client`delete from audit_events where id = ${seededId}`;
    await client?.end();
  }
});
