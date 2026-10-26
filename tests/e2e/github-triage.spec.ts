import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels + journey for GitHub triage drafts (ASH-284): a seeded
 * github.issue.triage proposal card in Reviews, on desktop and mobile.
 * The card must carry the capability-keyed decision-only copy (nothing
 * changes on GitHub), the expanded payload must show the exact approved
 * coordinates, and approving must record the decision and NOTHING else:
 * the reloaded card shows the decision, and zero executor attempt rows
 * exist (no executor, so no GitHub call is possible). Seeds straight into
 * the CI database; cleans up in afterAll. No GitHub token, no network to
 * GitHub: the seeded proposal is the whole surface under test.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const DECISION_ONLY_COPY =
  "Approving records the decision only. Nothing changes on GitHub - labels, assignees, and close state stay exactly as they are until you apply them there.";

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

async function seedTriageProposal(tag: string): Promise<{ id: string; title: string; expectedEffect: string } | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    const issueNumber = 9000 + Math.floor(Math.random() * 999);
    const issueTitle = `Inbox badge keeps a stale count (${tag})`;
    const title = `Triage ashwinrachhavt/Polymath#${issueNumber}: ${issueTitle}`;
    const expectedEffect = `On ashwinrachhavt/Polymath#${issueNumber}: add labels bug; assign @ashwinrachhavt. Nothing is applied automatically.`;
    const payload = {
      owner: "ashwinrachhavt",
      repo: "Polymath",
      issueNumber,
      issueTitle,
      changes: { addLabels: ["bug"], removeLabels: [], assignees: ["ashwinrachhavt"] },
      rationale: `Badge count never clears after the last read (${tag}); looks like a cache invalidation miss.`,
      changesHash: `e2e${Math.random().toString(16).slice(2, 15)}`,
    };
    const [proposal] = await client<{ id: string }[]>`
      insert into action_proposals (workspace_id, capability, risk_class, status, target_type, title, expected_effect, dedupe_key, expires_at, created_by, updated_by)
      values (
        ${owner.workspace_id}, 'github.issue.triage', 'prepare', 'pending', 'github_issue',
        ${title}, ${expectedEffect}, ${`e2e-gh-triage:${tag}:${payload.changesHash}`},
        now() + interval '3 days', ${owner.user_id}, ${owner.user_id})
      returning id`;
    await client`
      insert into action_revisions (workspace_id, proposal_id, revision_number, payload, preview)
      values (${owner.workspace_id}, ${proposal.id}, 1, ${JSON.stringify(payload)}::jsonb, null)`;
    return { id: proposal.id, title, expectedEffect };
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  const client = db();
  if (!client) return;
  try {
    await client`delete from action_proposals where dedupe_key like 'e2e-gh-triage:%'`;
  } finally {
    await client.end();
  }
});

for (const vp of VIEWPORTS) {
  test(`a triage card is decision-only, end to end [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // Both viewport variants run in parallel; the tag keeps each variant's
    // seed, assertions, and cleanup on its own card.
    const seeded = await seedTriageProposal(vp.name);
    test.skip(!seeded, "DATABASE_URL not configured");
    const { title, expectedEffect } = seeded!;

    await page.goto("/reviews");
    const card = page.locator("section.panel").filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 30_000 });
    // The capability-keyed decision-only copy, not the generic line.
    await expect(card).toContainText(DECISION_ONLY_COPY);
    // The effect line is honest: it names the changes and disclaims application.
    await expect(card).toContainText(expectedEffect);
    await expect(card).toContainText("Nothing is applied automatically.");
    await page.screenshot({ path: `test-results/feature-pixels/triage-card-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

    // The exact payload the approval binds: coordinates and changes visible.
    await card.getByText("Inspect the exact payload").click();
    const payloadPre = card.locator("details pre").first();
    await expect(payloadPre).toBeVisible();
    await expect(payloadPre).toContainText('"issueNumber"');
    await expect(payloadPre).toContainText('"addLabels"');
    await expect(payloadPre).toContainText('"changesHash"');
    await expect(payloadPre).toContainText('"rationale"');
    await card.screenshot({ path: `test-results/feature-pixels/triage-payload-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // Approve: the card decides in place and shows the decided view.
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(card).toContainText("Decided", { timeout: 30_000 });

    // Reload: the decision is server truth, and nothing executed - no
    // outcome line, no "sent"/"applied" language anywhere on the card.
    await page.reload();
    const decided = page.locator("section.panel").filter({ hasText: title });
    await expect(decided).toBeVisible({ timeout: 30_000 });
    await expect(decided).toContainText("Decided");
    await expect(decided).toContainText("approved");
    await expect(decided).not.toContainText("Sent");
    await expect(decided).not.toContainText("applied");
    await page.screenshot({ path: `test-results/feature-pixels/triage-decided-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

    // Zero GitHub effect, provable in the database: the proposal is decided
    // and no executor attempt row exists for it.
    const reader = db();
    const [row] = await reader!<{ status: string; attempts: string }[]>`
      select p.status,
        (select count(*)::text from action_attempts a where a.proposal_id = p.id) as attempts
      from action_proposals p where p.id = ${seeded!.id}`;
    await reader!.end();
    expect(row.status).toBe("approved");
    expect(Number(row.attempts)).toBe(0);
  });
}
