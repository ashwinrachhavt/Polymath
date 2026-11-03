import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * The working Access console (D5), as an owner manages a real second member:
 * a role change applies and persists, removal ends access, the sole owner's
 * own role control sits disabled with the reason, and leaving a sole-owned
 * workspace is refused with the domain's copy. The keyless dev harness holds
 * exactly one signed-in session (the dev owner), so the member-view state and
 * the leave-success journey — which need a second session — are proven in the
 * integration suite (members-console.test.ts) instead of here.
 */

const MEMBER_EMAIL = `access-console-${crypto.randomUUID()}@e2e.example.com`;

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

/** A second member in the dev owner's workspace, with a findable email. */
async function seedMember(): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const [ws] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!ws) return null;
    const [u] = await client<{ id: string }[]>`
      insert into users (clerk_user_id, email)
      values (${"e2e_ac_" + crypto.randomUUID()}, ${MEMBER_EMAIL})
      returning id`;
    await client`
      insert into memberships (workspace_id, user_id, role, status)
      values (${ws.workspace_id}, ${u.id}, 'member', 'active')`;
    return u.id;
  } finally {
    await client.end();
  }
}

async function memberRoleInDb(): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const [row] = await client<{ role: string }[]>`
      select m.role from memberships m join users u on u.id = m.user_id where u.email = ${MEMBER_EMAIL}`;
    return row?.role ?? null;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  // The user delete cascades to the membership (identity schema).
  const client = db();
  if (!client) return;
  try {
    await client`delete from users where email = ${MEMBER_EMAIL}`;
  } finally {
    await client.end();
  }
});

test("the owner manages a member and the sole-owner guard holds", async ({ page }) => {
  const memberId = await seedMember();
  test.skip(!memberId, "DATABASE_URL is not configured");

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/settings/access");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByText(MEMBER_EMAIL)).toBeVisible();

  // Role change applies on select and persists to the workspace's row.
  const roleControl = table.getByLabel(`Role for ${MEMBER_EMAIL}`);
  await roleControl.selectOption("admin");
  await expect(table.getByLabel(`Role for ${MEMBER_EMAIL}`)).toHaveValue("admin");
  await expect.poll(async () => memberRoleInDb(), { timeout: 10_000 }).toBe("admin");

  // Removal confirms through the dialog and the row reports the new status.
  await table.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove member" }).click();
  await expect(table.getByText("removed", { exact: true })).toBeVisible();
  await expect.poll(async () => memberRoleInDb(), { timeout: 10_000 }).toBe("admin");

  // The dev owner is the sole active owner: their own role control is the
  // disabled-with-reason state, and it is the only select left on the page.
  const ownRole = page.getByRole("combobox");
  await expect(ownRole).toHaveCount(1);
  await expect(ownRole).toBeDisabled();
  await expect(ownRole).toHaveAttribute("title", "A workspace needs at least one active owner.");

  // Leaving a sole-owned workspace is refused with the domain's authored copy.
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.getByRole("button", { name: "Leave workspace" }).click();
  await expect(page.getByText("A workspace needs at least one active owner.")).toBeVisible();

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  expect(errors).toEqual([]);
});
