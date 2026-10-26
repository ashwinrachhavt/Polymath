import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * The connectors tier journey: what the owner sees and what the agent may do
 * must agree. The card names the tier; the gateway enforces it; raising the
 * tier admits a proposal; lowering it denies the same call, naming the control
 * that owns the decision.
 *
 * The OAuth handshake is not under test here (integration coverage lands the
 * account row); the account is seeded active, exactly what a completed
 * connection leaves behind.
 *
 * Steps 3-4 drive the real gateway over HTTP, which needs EVE_GATEWAY_SECRET
 * (the same value the dev server loaded). Without it those steps skip with the
 * reason stated — never silently.
 */

function connection(): string | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env: the caller skips, the way the other data-dependent journeys do.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

// The test process does not inherit env; load the files the dev server loaded.
// Node's loadEnvFile does not override an already-set key, so the
// higher-precedence file loads first: .env.local wins for shared keys, .env
// fills the rest.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent file: keep going; the gateway leg skips with a stated reason.
  }
}
const GATEWAY_SECRET = process.env.EVE_GATEWAY_SECRET?.trim() ?? "";

// The gateway resolves accounts per workspace, and every test shares dev-user's
// workspace: three parallel workers would seed three active gmail accounts and
// make every send ambiguous. One worker for the whole file.
test.describe.configure({ mode: "serial" });
test.slow();

let client: postgres.Sql | null = null;
let seeded: { workspaceId: string; accountId: string; alias: string; runId: string } | null = null;
let token: string | null = null;

/** The e2e account's row inside the gmail card, distinguished from the workspace's real accounts by its alias. */
function e2eAccountRow(page: import("@playwright/test").Page) {
  return page.locator("div.py-3", { hasText: seeded!.alias });
}

test.beforeAll(async () => {
  const url = connection();
  test.skip(!url, "The connectors journey reads Postgres; set DATABASE_URL.");
  if (!url) return;
  client = postgres(url, { max: 1 });

  // The dev harness provisions dev-user's workspace on a prior page visit;
  // visiting the app first (below in the test) guarantees it, but the seed
  // runs before any test body, so resolve it here and skip when absent.
  const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
    select m.workspace_id, u.id as user_id
    from memberships m
    join users u on u.id = m.user_id
    where u.clerk_user_id = 'dev-user' and m.status = 'active'
    limit 1
  `;
  test.skip(!owner, "dev-user has no workspace yet; open the app once to provision it.");
  if (!owner) return;

  const alias = `e2e-gmail-${crypto.randomUUID().slice(0, 8)}`;
  const [account] = await client<{ id: string }[]>`
    insert into external_accounts (workspace_id, provider, alias, status, composio_connected_account_id, access_tier)
    values (${owner.workspace_id}, 'gmail', ${alias}, 'active', ${`ca_e2e_${crypto.randomUUID()}`}, 'read_only')
    returning id
  `;

  const [profile] = await client<{ id: string }[]>`
    insert into agent_profiles (workspace_id, name, is_default, allowed_tools)
    values (${owner.workspace_id}, 'alfred', true, '["gmail.send","gmail.read","gmail.thread.read"]'::jsonb)
    on conflict (workspace_id, name) do update set updated_at = now()
    returning id
  `;

  const sessionRef = `wrun_e2e_${crypto.randomUUID()}`;
  const [run] = await client<{ id: string }[]>`
    insert into agent_runs (workspace_id, agent_profile_id, objective, state, session_ref, policy_snapshot, created_by)
    values (${owner.workspace_id}, ${profile.id}, 'E2E tier journey', 'running', ${sessionRef},
            ${JSON.stringify({ allowedTools: ["gmail.send", "gmail.read", "gmail.thread.read"] })}::jsonb,
            ${owner.user_id})
    returning id
  `;
  seeded = { workspaceId: owner.workspace_id, accountId: account.id, alias, runId: run.id };

  if (GATEWAY_SECRET.length >= 32) {
    const { signGatewayToken } = await import("@/domains/agents/gateway-token");
    token = signGatewayToken(
      { runId: run.id, userId: owner.user_id, workspaceId: owner.workspace_id },
      { secret: GATEWAY_SECRET },
    );
  }
});

test.afterAll(async () => {
  if (!client || !seeded) return;
  await client`delete from agent_runs where id = ${seeded.runId}`;
  await client`delete from external_accounts where id = ${seeded.accountId}`;
  await client.end();
});

async function setTier(tierId: string) {
  if (!client || !seeded) throw new Error("seed missing");
  await client`
    update external_accounts set access_tier = ${tierId}, version = version + 1
    where id = ${seeded.accountId}
  `;
}

async function callGateway(tool: string, args: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const response = await fetch("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  // Tool results ride inside a 200 body as content text; refusals (tier gate,
  // policy) are problem-detail responses on the transport status. Read both.
  const body = (await response.json()) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string };
    title?: string;
  };
  const text = body.result?.content?.[0]?.text ?? body.error?.message ?? body.title ?? "";
  return { status: response.status, text };
}

test("the connectors card names the tier, offers the picker, and marks tierless providers Coming soon", async ({ page }) => {
  await page.goto("/command-center/integrations");

  // The seeded gmail account is connected at read_only: the card badge says
  // Connected and the row is the account's.
  const row = e2eAccountRow(page);
  await expect(row).toBeVisible();
  await expect(page.locator("article", { hasText: "Gmail" }).getByText("Connected", { exact: true })).toBeVisible();
  // The seeded gmail account is read_only: Read on, Send off.
  const readSwitch = row.getByRole("switch", { name: "Read" });
  const sendSwitch = row.getByRole("switch", { name: "Send", exact: true });
  await expect(readSwitch).toBeVisible();
  await expect(readSwitch).toHaveAttribute("aria-checked", "true");
  await expect(sendSwitch).toHaveAttribute("aria-checked", "false");

  // Dropbox's list read is POST-shaped, so it has no tiers — not connectable.
  const dropboxCard = page.locator("article", { hasText: "Dropbox" }).first();
  await expect(dropboxCard.getByText("Coming soon")).toBeVisible();
});

test("raising the tier persists across a reload, and lowering it back does too", async ({ page }) => {
  await page.goto("/command-center/integrations");

  // Flipping Send on raises the account to the tier granting gmail.send.
  const row = () => e2eAccountRow(page).getByRole("switch", { name: "Send", exact: true });
  await row().click();
  await expect(row()).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(row()).toHaveAttribute("aria-checked", "true");

  await setTier("read_only");
  await page.reload();
  await expect(row()).toHaveAttribute("aria-checked", "false");
});

test("a send within the tier files a proposal; a send above it is denied naming the tier control", async () => {
  test.skip(!token, "Steps 3-4 need EVE_GATEWAY_SECRET (32+ chars) to mint a gateway token for the seeded run.");
  if (!seeded) throw new Error("seed missing");

  await setTier("read_send");

  const send = {
    to: "recipient@example.invalid",
    subject: "E2E tier journey",
    body: "Filed from the connectors journey.",
    messageId: `e2e-${Date.now()}`,
  };

  // Within the tier: a proposal the owner reviews, not a denial.
  const allowed = await callGateway("gmail_send", { ...send, accountAlias: seeded.alias });
  expect(allowed.text).toContain("awaiting_review");

  // Lower the tier mid-journey; the same call is now refused, naming the control.
  await setTier("read_only");
  const denied = await callGateway("gmail_send", { ...send, messageId: `e2e-denied-${Date.now()}` });
  expect(denied.status).toBe(403);
  expect(denied.text).toContain("Agent access");
  expect(denied.text).toContain("Connectors");
});
