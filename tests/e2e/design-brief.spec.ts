import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the design brief (ASH-286, partial): the research-card toolbar
 * control, the one-click journey into a generated brief memo, the source
 * linkage and honest handoff boundary on the brief page, repeat-click
 * idempotency, the kind gate (a transcript never offers the button), and the
 * empty-source error. Runs against the free fixture provider
 * (GENERATION_PROVIDER=fixture): no model key, no spend.
 *
 * Screenshots land in test-results/feature-pixels/ and upload as the
 * feature-pixels CI artifact. The seeded rows are removed in afterAll.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const SOURCE_TITLE = "Competitor pricing research";
const SOURCE_TEXT =
  "Acme raised prices 15% in September and now gates reporting behind the top tier. " +
  "Two interviewees said renewal conversations stall without a one-page summary of what ships next. " +
  "Our Q3 roadmap adds the reporting and billing controls they named.";

const seededSourceIds: string[] = [];

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

/** A briefable (or deliberately not) artifact the dev owner's workspace owns. Null when no database. */
async function seedArtifact(kind: "report" | "transcript" | "note", title: string, text: string): Promise<{ id: string } | null> {
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
        ${text},
        'created', ${owner.user_id})
      returning id`;
    await client`update artifacts set current_version_id = ${version.id} where id = ${artifact.id}`;
    seededSourceIds.push(artifact.id);
    return artifact;
  } finally {
    await client.end();
  }
}

async function briefCountFor(sourceId: string): Promise<number> {
  const client = db();
  if (!client) return -1;
  try {
    const [{ count }] = await client<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where action = 'knowledge.design_brief.generated'
        and metadata ->> 'sourceArtifactId' = ${sourceId}`;
    return Number(count);
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client || seededSourceIds.length === 0) return;
  try {
    // Briefs generated from the seeded sources go first; the audit rows stay
    // (audit is append-only) and stop matching once their subject is gone.
    await client`
      delete from artifacts where id in (
        select subject_id from audit_events
        where action = 'knowledge.design_brief.generated'
          and metadata ->> 'sourceArtifactId' = any(${seededSourceIds}::text[])
      )`;
    await client`delete from artifacts where id = any(${seededSourceIds}::uuid[])`;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

for (const vp of VIEWPORTS) {
  test(`draft a design brief from a research card, idempotent on repeat click [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("report", SOURCE_TITLE, SOURCE_TEXT);
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    await expect(page.getByRole("button", { name: "Design brief" })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-button-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.getByRole("button", { name: "Design brief" }).click();
    await expect(page.getByRole("status")).toContainText("Brief drafted", { timeout: 60_000 });
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-drafted-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // Repeat click: the same brief comes back, no duplicate is written.
    await page.getByRole("button", { name: "Design brief" }).click();
    await expect(page.getByRole("status")).toContainText("Brief already drafted", { timeout: 60_000 });
    expect(await briefCountFor(artifact!.id)).toBe(1);

    // The brief page: generated content, source linkage, honest handoff note.
    const openLink = page.getByRole("link", { name: "Open brief" });
    await expect(openLink).toBeVisible();
    const href = await openLink.getAttribute("href");
    expect(href).toMatch(/^\/artifacts\//);
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1, name: "Design brief: Q3 roadmap one-pager" })).toBeVisible();
    await expect(page.getByText(`Design brief from "${SOURCE_TITLE}"`)).toBeVisible();
    await expect(page.getByText("The Canva handoff is not available yet")).toBeVisible();
    await expect(page.getByText("Account executives preparing for renewal conversations.")).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-page-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });

  test(`a transcript never offers the design brief [${vp.name}]`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("transcript", "Weekly sync transcript (brief gate)", "speaker: hello");
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Weekly sync transcript (brief gate)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Design brief" })).toHaveCount(0);
  });

  test(`an empty source shows the honest error instead of writing a brief [${vp.name}]`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("note", "An empty note (brief)", "");
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    await page.getByRole("button", { name: "Design brief" }).click();
    // Next's route announcer also carries role=alert; match the message text itself.
    await expect(page.getByText("This artifact has no text to brief from.")).toBeVisible({ timeout: 30_000 });
    expect(await briefCountFor(artifact!.id)).toBe(0);
  });
}
