import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for sender grants (ASH-289): the Sending-grants block on the Gmail
 * connector card, the toggle journey (check an alias, save, persisted) and
 * the copy that explains the unrestricted default. No model involved.
 * Screenshots upload as the feature-pixels CI artifact.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const ALIAS = "ashwin.sendergrants.e2e@example.com";

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

/** One active gmail account so the connector card renders its grant block. */
async function seedGmailAccount(): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return false;
    await client`
      insert into external_accounts (workspace_id, provider, alias, status, composio_connected_account_id, access_tier)
      values (${owner.workspace_id}, 'gmail', ${ALIAS}, 'active', ${`ca_e2e_${crypto.randomUUID()}`}, 'read_only')
      on conflict do nothing`;
    return true;
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`delete from external_accounts where alias = ${ALIAS}`;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

for (const vp of VIEWPORTS) {
  test(`grant and revoke a sending alias [${vp.name}]`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    test.skip(!(await seedGmailAccount()), "DATABASE_URL not configured");

    await page.goto("/command-center/integrations");
    const grants = page.getByTestId("sender-grants");
    await expect(grants).toBeVisible({ timeout: 30_000 });
    // The unrestricted default reads plainly before anything is checked.
    await expect(grants.getByText(/none checked, any connected account may send/)).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/sender-grants-${vp.name}.png`, style: HIDE_DEV_CHROME });

    const box = grants.getByRole("checkbox", { name: ALIAS });
    await box.check();
    await grants.getByRole("button", { name: /save|grant/i }).click();
    await expect(grants.getByText("Sending grants saved.")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/sender-grants-saved-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // The grant survives a reload: it is persisted, not a local toggle.
    await page.reload();
    await expect(page.getByTestId("sender-grants").getByRole("checkbox", { name: ALIAS })).toBeChecked({ timeout: 30_000 });

    // Revoke: uncheck and save again, leaving the workspace unrestricted.
    const grantsAfter = page.getByTestId("sender-grants");
    await grantsAfter.getByRole("checkbox", { name: ALIAS }).uncheck();
    await grantsAfter.getByRole("button", { name: /save|grant/i }).click();
    await expect(grantsAfter.getByText("Sending grants saved.")).toBeVisible({ timeout: 30_000 });
  });
}
