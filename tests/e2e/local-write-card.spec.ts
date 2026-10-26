import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for a local-write review card (ASH-284 follow-up): approving a task
 * proposal creates the task, so the card must NOT carry the decision-only
 * caveat - the effect line is the truth and approval does it. Regression
 * evidence for the effect-path classification in reviews/decision-scope.ts.
 * Screenshots upload as the feature-pixels CI artifact.
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

async function seedTaskProposal(vp: string): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    const title = `Sketch the migration plan (${vp})`;
    const [proposal] = await client<{ id: string }[]>`
      insert into action_proposals (workspace_id, capability, risk_class, target_type, title, expected_effect, dedupe_key)
      values (${owner.workspace_id}, 'tasks.create', 'prepare', 'task', ${`Add task: ${title}`}, ${`Creates the task "${title}" in your inbox.`}, ${`tasks:e2e-localwrite-${vp}`})
      returning id`;
    await client`
      insert into action_revisions (workspace_id, proposal_id, revision_number, payload)
      values (${owner.workspace_id}, ${proposal.id}, 1, ${JSON.stringify({ title })}::jsonb)`;
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

for (const vp of VIEWPORTS) {
  test(`a local-write card promises the write, not "decision only" [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const seeded = await seedTaskProposal(vp.name);
    test.skip(!seeded, "DATABASE_URL not configured");
    try {
      await page.goto("/reviews");
      // Scope to this card: other specs' cards (e.g. a triage card, which
      // SHOULD carry the caveat) can share the queue mid-run.
      const card = page.locator("section", { hasText: `Add task: Sketch the migration plan (${vp.name})` });
      await expect(card.getByText(/Creates the task "Sketch the migration plan/)).toBeVisible({ timeout: 30_000 });
      // The regression: this caveat claimed approval only records a decision
      // while approval actually creates the task.
      await expect(card.getByText(/records the decision only/)).toHaveCount(0);
      await page.screenshot({ path: `test-results/feature-pixels/local-write-card-${vp.name}.png`, style: HIDE_DEV_CHROME });
    } finally {
      await removeProposal(seeded!);
    }
  });
}
