import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the new-sender contact switch (ASH-287): the connector-card
 * switch off, on, and blocked while read access is revoked (where stopping
 * must still work), plus the contact proposal the daily pass puts in
 * Reviews. The behavior itself is pinned by the db integration suites; this
 * spec photographs the owner-facing surfaces on the integrated head.
 *
 * One test walks the viewports sequentially against one seeded Gmail
 * account: the switch writes the account's trigger row, and concurrent
 * viewport passes on one row would race (see sender-grants.spec.ts).
 * Screenshots upload as the feature-pixels CI artifact.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const ALIAS = "ashwin.senderproposals.e2e@example.com";

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

async function seedAccount(): Promise<{ workspaceId: string; accountId: string } | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    await client`delete from external_accounts where alias = ${ALIAS}`;
    const [account] = await client<{ id: string }[]>`
      insert into external_accounts (workspace_id, provider, alias, status, composio_connected_account_id, access_tier)
      values (${owner.workspace_id}, 'gmail', ${ALIAS}, 'active', ${`ca_e2e_${crypto.randomUUID()}`}, 'read_only')
      returning id`;
    return { workspaceId: owner.workspace_id, accountId: account.id };
  } finally {
    await client.end();
  }
}

/** Fresh off state: no trigger row, read access back on, account active. */
async function resetSwitch(accountId: string): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`delete from triggers where external_account_id = ${accountId} and event_type = 'crm.sender_proposals'`;
    await client`delete from sync_cursors where external_account_id = ${accountId}`;
    await client`update external_accounts set status = 'active', allow_read = true where id = ${accountId}`;
  } finally {
    await client.end();
  }
}

async function setAllowRead(accountId: string, allow: boolean): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`update external_accounts set allow_read = ${allow} where id = ${accountId}`;
  } finally {
    await client.end();
  }
}

/** The contact proposal the daily pass writes, in the production shape. */
async function seedContactProposal(workspaceId: string, vp: string): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const fullName = `Maya Okonkwo (${vp})`;
    const email = `maya.${vp}@bluebirdstudio.io`;
    const payload = {
      fullName,
      email,
      company: { name: "Bluebird Studio", domain: "bluebirdstudio.io" },
      source: {
        provider: "gmail",
        messageId: "m-e2e-1",
        threadId: "th-e2e-1",
        threadUrl: "https://mail.google.com/mail/u/0/#inbox/th-e2e-1",
        subject: "Studio availability in November",
        receivedAt: new Date().toISOString(),
      },
    };
    const effect = `Adds ${fullName} <${email}> to your contacts, with a new company, Bluebird Studio (bluebirdstudio.io), and keeps the email thread as their first correspondence.`;
    const [proposal] = await client<{ id: string }[]>`
      insert into action_proposals (workspace_id, capability, risk_class, target_type, title, expected_effect, dedupe_key)
      values (${workspaceId}, 'crm.contact.create', 'prepare', 'contact', ${`Add contact: ${fullName}`}, ${effect}, ${`crm-sender:${email}`})
      returning id`;
    await client`
      insert into action_revisions (workspace_id, proposal_id, revision_number, payload, preview)
      values (${workspaceId}, ${proposal.id}, 1, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(payload)}::jsonb)`;
    return proposal.id;
  } finally {
    await client.end();
  }
}

async function removeProposal(id: string): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`delete from action_proposals where id = ${id}::uuid`;
  } finally {
    await client.end();
  }
}

test("the sender-contact switch in every state, and the review card", async ({ page }) => {
  test.setTimeout(240_000);
  const seeded = await seedAccount();
  test.skip(!seeded, "DATABASE_URL not configured");
  const { workspaceId, accountId } = seeded!;

  for (const vp of VIEWPORTS) {
    await resetSwitch(accountId);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/command-center/integrations");
    const row = page.locator("div.rounded-md.border", { hasText: `new inbound senders on ${ALIAS}` });
    const toggle = row.getByRole("switch", { name: "Suggest contacts from new senders" });

    // Off by default: nothing runs until the owner turns it on.
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).not.toBeChecked();
    await expect(row.getByText("Starts from the moment you turn it on.")).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/sender-switch-off-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // On: the owner opted the account in.
    await toggle.click();
    await expect(toggle).toBeChecked({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/sender-switch-on-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // Read access revoked while on: the pass pauses, the card says why, and
    // the switch still turns off - stopping never depends on the read.
    await setAllowRead(accountId, false);
    await page.reload();
    await expect(row.getByText(/On, but not running: read access is off/)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/sender-switch-paused-${vp.name}.png`, style: HIDE_DEV_CHROME });
    await row.getByRole("switch", { name: "Suggest contacts from new senders" }).click();
    await expect(row.getByRole("switch", { name: "Suggest contacts from new senders" })).not.toBeChecked({ timeout: 30_000 });

    // Blocked while off: enabling is disabled with the reason named.
    await expect(row.getByText(new RegExp(`Turn on read access for ${ALIAS.replace(/\./g, "\\.")} to turn this on.`))).toBeVisible();
    await expect(row.getByRole("switch", { name: "Suggest contacts from new senders" })).toBeDisabled();
    await page.screenshot({ path: `test-results/feature-pixels/sender-switch-blocked-${vp.name}.png`, style: HIDE_DEV_CHROME });
    await setAllowRead(accountId, true);

    // The proposal the pass writes, as the owner sees it in Reviews.
    const proposalId = await seedContactProposal(workspaceId, vp.name);
    try {
      await page.goto("/reviews");
      await expect(page.getByText(`Add contact: Maya Okonkwo (${vp.name})`)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/with a new company, Bluebird Studio/).first()).toBeVisible();
      await page.screenshot({ path: `test-results/feature-pixels/crm-contact-card-${vp.name}.png`, style: HIDE_DEV_CHROME });
    } finally {
      if (proposalId) await removeProposal(proposalId);
    }
  }
});
