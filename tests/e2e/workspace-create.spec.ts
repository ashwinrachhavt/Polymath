import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * The create-workspace journey end to end (spec D3): the dev owner fills the
 * form, the command creates the workspace with its owner membership and
 * audit event, the action writes the per-device active-workspace cookie, and
 * the full navigation lands them in the new workspace - which, being fresh,
 * opens its own onboarding conversation (the product's first-run gate). The
 * journey is repeatable against a warm database: the name carries a
 * run-unique tag, so the auto slug never collides and nothing is cleaned up.
 */
function db() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

test("creating a workspace lands the creator inside it", async ({ page }) => {
  test.setTimeout(180_000);
  const client = db();
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    // test.skip ends the test at runtime; the assertion narrows for the queries.
    const sql = client!;
    const tag = Date.now().toString(36);
    const name = `Second Space ${tag}`;

    await page.goto("/workspaces/create");
    await expect(page.getByRole("heading", { level: 1, name: "Create a workspace" })).toBeVisible();
    await page.screenshot({ path: "test-results/feature-pixels/workspace-create-form.png", fullPage: true });

    // Type the name only: the address field pre-fills and stays untouched, so
    // the action takes the auto path (derive from the name).
    await page.locator('input[name="name"]').fill(name);
    await page.getByRole("button", { name: "Create workspace" }).click();

    // Landed in the new workspace: fresh, so the first-run gate opens its
    // onboarding conversation.
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 30_000 });

    // The device now resolves into the new workspace by cookie...
    const cookie = (await page.context().cookies()).find((c) => c.name === "polymath_active_workspace");
    expect(cookie, "the active-workspace cookie names the new workspace").toBeTruthy();

    // ...and the command's three legs all exist: workspace, owner membership,
    // audit event.
    const [workspace] = await sql`select id, slug from workspaces where name = ${name}`;
    expect(workspace, "the workspace row exists").toBeTruthy();
    expect(workspace.slug).toBe(`second-space-${tag}`);
    expect(cookie!.value).toBe(workspace.id);
    const [membership] = await sql`select role, status from memberships where workspace_id = ${workspace.id}`;
    expect(membership.role).toBe("owner");
    expect(membership.status).toBe("active");
    const [audit] =
      await sql`select action from audit_events where workspace_id = ${workspace.id} and action = 'workspace.created'`;
    expect(audit, "the workspace.created audit event exists").toBeTruthy();

    await page.screenshot({ path: "test-results/feature-pixels/workspace-created.png", fullPage: true });
  } finally {
    await client?.end();
  }
});
