import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for the design brief (ASH-286): the research-card toolbar control,
 * the one-click journey into a generated brief memo, the source linkage and
 * handoff note on the brief page, repeat-click idempotency, the kind gate (a
 * transcript never offers the button), the empty-source error, and the Canva
 * handoff: "Send to Canva" files a proposal, a repeat click resolves it, the
 * owner approves the exact revision in Reviews, and the outcome line stays
 * honest when no provider key exists in this environment (no live write).
 * Runs against the free fixture provider (GENERATION_PROVIDER=fixture): no
 * model key, no spend.
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

const seededCanvaAccountIds: string[] = [];

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client || (seededSourceIds.length === 0 && seededCanvaAccountIds.length === 0)) return;
  try {
    if (seededSourceIds.length > 0) {
      // Handoff proposals for briefs from the seeded sources go first
      // (attempts, reviews, revisions and observations cascade), then the
      // briefs, then the sources. Audit rows stay (append-only).
      await client`
        delete from action_proposals where capability = 'canva.design.import' and target_id in (
          select subject_id from audit_events
          where action = 'knowledge.design_brief.generated'
            and metadata ->> 'sourceArtifactId' = any(${seededSourceIds}::text[])
        )`;
      await client`
        delete from artifacts where id in (
          select subject_id from audit_events
          where action = 'knowledge.design_brief.generated'
            and metadata ->> 'sourceArtifactId' = any(${seededSourceIds}::text[])
        )`;
      await client`delete from artifacts where id = any(${seededSourceIds}::uuid[])`;
    }
    if (seededCanvaAccountIds.length > 0) {
      await client`delete from external_accounts where id = any(${seededCanvaAccountIds}::uuid[])`;
    }
  } finally {
    await client.end();
  }
}

/** A connected Canva account for the handoff journey's executor resolution. */
async function seedCanvaAccount(): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return false;
    const alias = `canva-e2e-${crypto.randomUUID().slice(0, 8)}`;
    const [account] = await client<{ id: string }[]>`
      insert into external_accounts (workspace_id, provider, alias, status, composio_connected_account_id, created_by, updated_by)
      values (${owner.workspace_id}, 'canva', ${alias}, 'active', ${`ca_e2e_${crypto.randomUUID()}`}, ${owner.user_id}, ${owner.user_id})
      returning id`;
    seededCanvaAccountIds.push(account.id);
    return true;
  } finally {
    await client.end();
  }
}

/** Attempt rows the handoff left behind, for the dispatch-wiring assertion. */
async function importAttemptCount(): Promise<number> {
  const client = db();
  if (!client) return -1;
  try {
    const [{ count }] = await client<{ count: string }[]>`
      select count(*)::text as count from action_attempts a
      join action_proposals p on p.id = a.proposal_id
      where p.capability = 'canva.design.import'`;
    return Number(count);
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

/** Every toolbar control stays inside the viewport: no control may clip past the right edge on any state. */
async function expectToolbarContained(page: Page, viewportWidth: number) {
  const toolbar = page.getByRole("toolbar", { name: "Artifact actions" });
  await expect(toolbar).toBeVisible();
  for (const child of await toolbar.locator(":scope > *").all()) {
    const box = await child.boundingBox();
    if (!box) continue;
    expect(box.x, "toolbar control starts on screen").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "toolbar control ends inside the viewport").toBeLessThanOrEqual(viewportWidth + 1);
  }
}

for (const vp of VIEWPORTS) {
  test(`draft a design brief from a research card, idempotent on repeat click [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("report", SOURCE_TITLE, SOURCE_TEXT);
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    await expect(page.getByRole("button", { name: "Design brief" })).toBeVisible();
    await expectToolbarContained(page, vp.width);
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-button-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.getByRole("button", { name: "Design brief" }).click();
    // Pending state: the toolbar must stay contained while the draft runs.
    await expect(page.getByRole("button", { name: "Drafting…" })).toBeVisible();
    await expectToolbarContained(page, vp.width);
    await expect(page.getByRole("status")).toContainText("Brief drafted", { timeout: 60_000 });
    // Settled state: capture only after the transition completes.
    await expect(page.getByRole("button", { name: "Design brief" })).toBeEnabled();
    await expectToolbarContained(page, vp.width);
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
    // One h1 only: the body does not repeat the title as a second heading.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByText(`Design brief from "${SOURCE_TITLE}"`)).toBeVisible();
    await expect(page.getByText("nothing imports until you approve it in Reviews")).toBeVisible();
    await expect(page.getByText("Account executives preparing for renewal conversations.")).toBeVisible();
    // Full-page stitching paints the sticky mobile nav mid-content; only the
    // desktop page is captured full-length, mobile proves at the real viewport.
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-page-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: vp.name === "desktop" });

    // The interim handoff: the toolbar's copy control really copies.
    // Headless Chromium denies clipboard-write unless it is granted.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy artifact markdown" }).click();
    await expect(page.getByRole("status")).toContainText("Copied");
  });

  test(`hand off a brief to Canva: proposal, then an honest unconfigured refusal [${vp.name}]`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("report", `${SOURCE_TITLE} (handoff)`, SOURCE_TEXT);
    test.skip(!artifact, "DATABASE_URL not configured");
    const accountSeeded = await seedCanvaAccount();
    test.skip(!accountSeeded, "DATABASE_URL not configured");

    // Generate the brief, then hand it off from the brief page.
    await page.goto(`/artifacts/${artifact!.id}`);
    await page.getByRole("button", { name: "Design brief" }).click();
    await expect(page.getByRole("status")).toContainText("Brief drafted", { timeout: 60_000 });
    await page.goto((await page.getByRole("link", { name: "Open brief" }).getAttribute("href"))!);
    await expect(page.getByRole("heading", { level: 1, name: "Design brief: Q3 roadmap one-pager" })).toBeVisible();

    const sendButton = page.getByRole("button", { name: "Send to Canva" });
    await expect(sendButton).toBeVisible();
    await expectToolbarContained(page, vp.width);
    await sendButton.click();
    await expect(page.getByRole("status")).toContainText("Import proposed", { timeout: 30_000 });
    await expectToolbarContained(page, vp.width);
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-handoff-proposed-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // Repeat click resolves the same proposal; no second one is filed.
    await sendButton.click();
    await expect(page.getByRole("status")).toContainText("Import already proposed", { timeout: 30_000 });

    // The review card names the exact effect and the unverified fidelity.
    await page.getByRole("link", { name: "Review in Reviews" }).click();
    await expect(page.getByText('Import design brief "Q3 roadmap one-pager" to Canva')).toBeVisible();
    await expect(page.getByText("Canva's rendering of the generated document is not verified yet")).toBeVisible();
    await expect(page.getByText("canva.design.import")).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-handoff-review-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: vp.name === "desktop" });

    // Approving runs the executor's gates. This environment has neither
    // CANVA_IMPORT_ENABLED nor a COMPOSIO_API_KEY, so dispatch is provably
    // impossible: the honest outcome is a refusal BEFORE any claim, the
    // approval stands, and no UNKNOWN attempt blocks the proposal against a
    // configuration fix. Enablement is the first gate: a generic Composio
    // key (present for Gmail) must never stand in for the Canva opt-in.
    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Canva import is not enabled on this deployment; the import cannot be dispatched." }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/design-brief-handoff-outcome-${vp.name}.png`, style: HIDE_DEV_CHROME });
    expect(await importAttemptCount()).toBe(0);

    // Reloaded, the refusal persists NO manufactured outcome: the approval
    // stands against a configuration fix, the card names no import and no
    // failure, and a decided card offers no way to fire again.
    await page.goto("/reviews?status=approved");
    await expect(page.getByText('Import design brief "Q3 roadmap one-pager" to Canva')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Imported to Canva.")).toHaveCount(0);
    await expect(page.getByText(/Not imported\./)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
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

  test(`copy without clipboard permission says so instead of pretending [${vp.name}]`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const artifact = await seedArtifact("report", "Copy-permission research", SOURCE_TEXT);
    test.skip(!artifact, "DATABASE_URL not configured");

    await page.goto(`/artifacts/${artifact!.id}`);
    // No grantPermissions here: the denied path must be honest feedback, not silence.
    await page.getByRole("button", { name: "Copy artifact markdown" }).click();
    await expect(page.getByText("Copy failed")).toBeVisible({ timeout: 30_000 });
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
