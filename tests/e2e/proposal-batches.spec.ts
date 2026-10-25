import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the proposal batches (ASH-303 debrief, ASH-300 learning paths):
 * the owner-facing controls and the whole click journey, against the free
 * fixture provider (GENERATION_PROVIDER=fixture) - no model key, no spend.
 *
 * Screenshots land in test-results/feature-pixels/ and upload as the
 * feature-pixels CI artifact. The seeded rows are removed in afterAll.
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

/** A transcript artifact the dev owner's workspace owns. Null when no database. */
async function seedTranscript(): Promise<{ id: string } | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    const [artifact] = await client<{ id: string }[]>`
      insert into artifacts (workspace_id, kind, title, status, created_by, updated_by)
      values (${owner.workspace_id}, 'note', 'Weekly sync transcript', 'reviewed', ${owner.user_id}, ${owner.user_id})
      returning id`;
    const [version] = await client<{ id: string }[]>`
      insert into artifact_versions (workspace_id, artifact_id, version_number, content, plain_text, reason, created_by)
      values (
        ${owner.workspace_id}, ${artifact.id}, 1,
        '{"type":"doc","content":[]}'::jsonb,
        ${"Priya: can you send the Q3 roadmap by Friday? Marcus: I still owe everyone the launch date. Decided: annual billing stays."},
        'created', ${owner.user_id})
      returning id`;
    await client`update artifacts set current_version_id = ${version.id} where id = ${artifact.id}`;
    return artifact;
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    // The batch's proposals, attempts and cards reference the artifacts;
    // removing them first keeps the developer's queue clean. The path note
    // is created by the journey itself, so it is caught by title.
    await client`delete from action_proposals where dedupe_key like 'tasks:meeting-debrief:%' or dedupe_key like 'notes:meeting-debrief:%' or dedupe_key like 'tasks:learning-path:%' or dedupe_key like 'notes:learning-path:%'`;
    await client`delete from cards where source_title = 'Understanding distributed consensus'`;
    await client`delete from artifacts where title in ('Weekly sync transcript', 'Understanding distributed consensus')`;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

for (const vp of VIEWPORTS) {
  test(`debrief a transcript into one batch of proposals [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedTranscript();
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    await expect(page.getByRole("button", { name: "Debrief into proposals" })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/debrief-button-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.getByRole("button", { name: "Debrief into proposals" }).click();
    await expect(page.getByRole("status")).toContainText("proposals in Reviews", { timeout: 60_000 });
    await page.screenshot({ path: `test-results/feature-pixels/debrief-done-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/reviews");
    await expect(page.getByText("Add task: Send the Q3 roadmap").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Add note: Pricing decision").first()).toBeVisible();
    await expect(page.getByText("Add task: Follow up with Marcus: confirm the launch date").first()).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/debrief-reviews-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

    // Cardinality, scoped to THIS transcript: .first() tolerates leftovers
    // from earlier attempts, but one debrief must produce exactly its three
    // proposals - never duplicates from the same transcript.
    const reader = db();
    const [{ count }] = await reader!<{ count: string }[]>`
      select count(*)::text as count from action_proposals
      where dedupe_key like ${`%meeting-debrief:${artifact!.id}:%`}`;
    await reader!.end();
    expect(Number(count)).toBe(3);
  });

  test(`a learning goal proposes notes, tasks and cards [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const client = db();
    test.skip(!client, "DATABASE_URL not configured");
    await client!.end();

    await page.goto("/alfred/knowledge/cards");
    await expect(page.getByRole("heading", { name: "Learning path", exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-form-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.getByLabel("Learning goal").fill("understand distributed consensus");
    await page.getByRole("button", { name: "Propose learning path" }).click();

    // Success navigates to the path note.
    await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
    // Page title carries the path title (the body starts with the overview).
    await expect(
      page.getByRole("heading", { level: 1, name: "Understanding distributed consensus" }),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-note-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/alfred/knowledge/cards");
    await expect(page.getByText("What does a quorum prevent?")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-card-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.goto("/reviews");
    await expect(page.getByText("Add note: Why consensus is hard").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Add task: Sketch Raft's election on paper").first()).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/learning-path-reviews-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });
}
