import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the meeting debrief (ASH-303): the transcript toolbar control,
 * the one-click batch journey into Reviews, and the eligibility gate - a
 * non-transcript artifact never offers the debrief. Runs against the free
 * fixture provider (GENERATION_PROVIDER=fixture): no model key, no spend.
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

/** Artifacts THIS worker seeded; cleanup stays scoped to them. */
const seededArtifactIds: string[] = [];

/** A transcript artifact the dev owner's workspace owns. Null when no database. */
async function seedArtifact(kind: "transcript" | "note", title: string): Promise<{ id: string } | null> {
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
      values (${owner.workspace_id}, ${kind}, ${title}, 'reviewed', ${owner.user_id}, ${owner.user_id})
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
    seededArtifactIds.push(artifact.id);
    return artifact;
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    // The batch's proposals reference the artifacts; removing them first
    // keeps the developer's queue clean. Scope every delete to the artifacts
    // THIS worker seeded: each parallel worker runs its own copy of this
    // module and its own afterAll, so an unscoped prefix/title delete wiped
    // the other viewport variant's proposals (and artifacts) mid-test - the
    // cardinality check then read 0 for an artifact whose debrief had just
    // reported its proposals (ASH-324).
    for (const id of seededArtifactIds) {
      await client`delete from action_proposals where dedupe_key like ${`%meeting-debrief:${id}:%`}`;
      await client`delete from artifacts where id = ${id}`;
    }
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
    const artifact = await seedArtifact("transcript", `Weekly sync transcript (${vp.name})`);
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

    // Full-page stitching paints the sticky mobile nav mid-list; prove at the
    // real viewport that the last proposal's controls scroll fully clear.
    if (vp.name === "mobile") {
      const lastApprove = page.getByRole("button", { name: "Approve" }).last();
      await lastApprove.scrollIntoViewIfNeeded();
      const approveBox = await lastApprove.boundingBox();
      const navBox = await page.getByRole("navigation", { name: "Destinations" }).boundingBox();
      expect(approveBox, "last proposal's Approve has a box").not.toBeNull();
      expect(navBox, "mobile bottom nav has a box").not.toBeNull();
      expect(
        approveBox!.y + approveBox!.height,
        "last proposal's controls render above the bottom nav",
      ).toBeLessThanOrEqual(navBox!.y);
    }

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

  test(`a non-transcript artifact never offers the debrief [${vp.name}]`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("note", `An ordinary generated note (${vp.name})`);
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `An ordinary generated note (${vp.name})` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Debrief into proposals" })).toHaveCount(0);
  });
}
