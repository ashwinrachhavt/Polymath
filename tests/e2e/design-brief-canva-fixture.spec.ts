import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";
import postgres from "postgres";

/*
 * The Canva handoff's ASYNC journey, end to end with zero possible real
 * transport (ASH-286): "Send to Canva" files the proposal, the owner approves
 * the exact revision in Reviews, the executor settles UNKNOWN with
 * note "import_started" (the provider accepted the job; its terminal answer
 * is pending), one dispatcher pass through the internal cron route polls the
 * job to its terminal state, and the attempt settles succeeded - all against
 * the explicit, nonproduction-only import fixture (CANVA_IMPORT_PROVIDER=
 * fixture), which returns before any network code runs and answers get-job
 * terminally. No COMPOSIO_API_KEY exists in this environment, so any real
 * transport would error rather than succeed quietly.
 *
 * Runs in its own invocation with the env var set; a global fixture flag
 * would mask the honest unconfigured-refusal journey in
 * design-brief.spec.ts. The spec skips itself without the opt-in so the
 * default suite stays truthful. Screenshots land in
 * test-results/feature-pixels/, one import-started and one terminal shot per
 * viewport.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const SOURCE_TITLE = "Partner launch research (fixture handoff)";
const SOURCE_TEXT =
  "Three partners asked for a one-page launch brief they can forward. " +
  "The June launch adds the shared review queue and the export controls they named.";

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

const seededSourceIds: string[] = [];
const seededCanvaAccountIds: string[] = [];

async function seedArtifact(title: string, text: string): Promise<{ id: string } | null> {
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
      values (${owner.workspace_id}, 'report', ${title}, 'reviewed', ${owner.user_id}, ${owner.user_id})
      returning id`;
    const [version] = await client<{ id: string }[]>`
      insert into artifact_versions (workspace_id, artifact_id, version_number, content, plain_text, reason, created_by)
      values (${owner.workspace_id}, ${artifact.id}, 1, '{"type":"doc","content":[]}'::jsonb, ${text}, 'created', ${owner.user_id})
      returning id`;
    await client`update artifacts set current_version_id = ${version.id} where id = ${artifact.id}`;
    seededSourceIds.push(artifact.id);
    return artifact;
  } finally {
    await client.end();
  }
}

/*
 * The seeded account id carries the journey's behavior marker; the fixture
 * provider reads it to answer (see canva/import.ts): "fail" settles the job
 * terminally failed, "pending" never settles, "ambiguous" loses the
 * creation answer entirely. Nonproduction data only.
 */
async function seedCanvaAccount(behavior?: "fail" | "pending" | "ambiguous"): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    // One journey = one connected Canva account. The executor refuses to
    // guess between two active accounts (ambiguity is surfaced, never
    // guessed), and serial journeys share this workspace: revoke any account
    // an earlier e2e journey seeded before connecting this journey's own.
    await client`
      update external_accounts set status = 'revoked'
      where workspace_id = ${owner.workspace_id} and provider = 'canva'
        and status = 'active' and alias like 'canva-e2e-%'`;
    const alias = `canva-e2e-fixture-${crypto.randomUUID().slice(0, 8)}`;
    const connectedId = `ca_e2e_${behavior ? `-${behavior}-` : ""}${crypto.randomUUID()}`;
    const [account] = await client<{ id: string }[]>`
      insert into external_accounts (workspace_id, provider, alias, status, composio_connected_account_id, created_by, updated_by)
      values (${owner.workspace_id}, 'canva', ${alias}, 'active', ${connectedId}, ${owner.user_id}, ${owner.user_id})
      returning id`;
    seededCanvaAccountIds.push(account.id);
    return alias;
  } finally {
    await client.end();
  }
}

type AttemptRow = { status: string; error_code: string | null; provider_object_id: string | null };

/** The newest import attempt, the row the whole journey is about. */
async function latestImportAttempt(): Promise<AttemptRow | null> {
  const client = db();
  if (!client) return null;
  try {
    const [row] = await client<AttemptRow[]>`
      select a.status, a.error_code, a.provider_object_id
      from action_attempts a
      join action_proposals p on p.id = a.proposal_id
      where p.capability = 'canva.design.import'
      order by a.created_at desc
      limit 1`;
    return row ?? null;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  const client = db();
  if (!client) return;
  try {
    if (seededSourceIds.length > 0) {
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
});

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

// One worker, in order: both viewport journeys share the seeded database and
// the newest-attempt probe, so parallel runs could race each other's rows.
test.describe.configure({ mode: "serial" });

for (const vp of VIEWPORTS) {
  test(`approve, wait, sweep: the fixture import reconciles to a terminal success [${vp.name}]`, async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.CANVA_IMPORT_PROVIDER !== "fixture", "fixture import journey needs CANVA_IMPORT_PROVIDER=fixture");
  await page.setViewportSize({ width: vp.width, height: vp.height });
  const artifact = await seedArtifact(`${SOURCE_TITLE} [${vp.name}]`, SOURCE_TEXT);
  test.skip(!artifact, "DATABASE_URL not configured");
  const accountAlias = await seedCanvaAccount();
  test.skip(!accountAlias, "DATABASE_URL not configured");
  const dispatchSecret = process.env.OUTBOX_DISPATCH_SECRET;
  test.skip(!dispatchSecret, "OUTBOX_DISPATCH_SECRET not configured");

  // Approve the exact revision. The fixture accepts the job: the honest
  // outcome is UNKNOWN with the import_started phase, named for a person.
  const { card, briefTitle } = await approveHandOff(page, artifact!.id, accountAlias!);
  await expect(
    card.getByRole("status").filter({ hasText: "Import job created; Polymath is waiting for Canva's terminal result." }),
  ).toBeVisible({ timeout: 30_000 });

  // Reload from the decided filter: the PERSISTED attempt outcome must say
  // what the decide response said. Async truth that vanishes on reload is no
  // truth at all - the reviewer leaves and comes back.
  await page.goto("/reviews?status=approved");
  await expect(page).toHaveURL(/status=approved/);
  const reloaded = page.locator("section").filter({ hasText: accountAlias! });
  await expect(
    reloaded.getByText("Import job created; Polymath is waiting for Canva's terminal result."),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `test-results/feature-pixels/design-brief-fixture-import-started-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

  // The attempt row is the async contract: UNKNOWN, job id pinned, in progress.
  const started = await latestImportAttempt();
  expect(started?.status).toBe("unknown");
  expect(started?.error_code).toBe("import_in_progress");
  expect(started?.provider_object_id).toMatch(/^fixture-import-/);

  // One dispatcher pass: the sweep asks the (fixture) job for its terminal
  // answer and settles the attempt. No provider key exists here, so a real
  // transport could not have produced this success.
  const response = await page.request.post("/api/internal/cron", {
    headers: { authorization: `Bearer ${dispatchSecret}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { reconciled?: number };
  expect(body.reconciled ?? 0).toBeGreaterThanOrEqual(1);

  const settled = await latestImportAttempt();
  expect(settled?.status).toBe("succeeded");
  expect(settled?.provider_object_id).toMatch(/^fixture-design-/);

  // Soft-nav refresh pin: the queue is still mounted from the import_started
  // reload above. Switching the filter re-renders from the server, and the
  // reconciled terminal truth must replace the stale pre-settle state.
  await page.getByLabel("Filter by status").selectOption("all");
  const settledCard = page.locator("section").filter({ hasText: accountAlias! });
  await expect(settledCard.getByText(`Import design brief "${briefTitle}"`)).toBeVisible({ timeout: 30_000 });
  await expect(settledCard.getByText("Imported to Canva.")).toBeVisible({ timeout: 30_000 });
  // The design link is the URL the (fixture) provider returned, verbatim.
  await expect(settledCard.getByRole("link", { name: "Open the design in Canva" })).toHaveAttribute(
    "href",
    /^https:\/\/www\.canva\.com\/design\/fixture-design-/,
  );
  await page.screenshot({ path: `test-results/feature-pixels/design-brief-fixture-terminal-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

  // Real-viewport reachability on mobile, proven in geometry and pixels -
  // the stylesheet model alone is not verification. The destinations nav is
  // sticky and in flow, so at max scroll it settles AFTER the last card:
  // nothing is permanently occluded, every control can be scrolled clear.
  // (The fullPage stitch above repaints the nav mid-content; that is a
  // capture artifact, not layout.)
  if (vp.name === "mobile") {
    await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      scroller.scrollTop = scroller.scrollHeight;
    });
    const geometry = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Destinations"]');
      const last = [...document.querySelectorAll("section")].at(-1);
      if (!nav || !last) return null;
      return { navTop: nav.getBoundingClientRect().top, lastCardBottom: last.getBoundingClientRect().bottom };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.lastCardBottom).toBeLessThanOrEqual(geometry!.navTop + 1);
    await page.screenshot({ path: "test-results/feature-pixels/design-brief-fixture-scrolled-mobile.png", style: HIDE_DEV_CHROME });
  }
});
}

/*
 * The draft -> hand-off -> approve flow every terminal journey shares.
 * Returns after the import_started line is visible (or, for a lost creation,
 * after the unconfirmed line is visible).
 */
async function approveHandOff(
  page: import("@playwright/test").Page,
  artifactId: string,
  accountAlias: string,
): Promise<{ card: import("@playwright/test").Locator; briefTitle: string }> {
  await page.goto(`/artifacts/${artifactId}`);
  await page.getByRole("button", { name: "Design brief" }).click();
  await expect(page.getByRole("status")).toContainText("Brief drafted", { timeout: 60_000 });
  await page.goto((await page.getByRole("link", { name: "Open brief" }).getAttribute("href"))!);
  // The generated title names the review card later; capture it rather than
  // assume the fixture generator's wording.
  const briefTitle =
    (await page.getByRole("heading", { level: 1 }).textContent())?.replace(/^Design brief:\s*/, "").trim() ?? "";
  expect(briefTitle).not.toBe("");
  await page.getByRole("button", { name: "Send to Canva" }).click();
  await expect(page.getByRole("status")).toContainText("Import proposed", { timeout: 30_000 });
  await page.getByRole("link", { name: "Review in Reviews" }).click();
  // Scope every interaction to this journey's card: the e2e workspace is
  // shared, and other specs' leftover proposals render Approve buttons too.
  const card = page.locator("section").filter({ hasText: accountAlias });
  // Hydration is the click-readiness gate, not a retry loop: waitSettled
  // holds until the shell's client store has hydrated (the header search
  // leaves its disabled SSR state), so this click lands on live handlers.
  // The journey's own status/refusal assertion below proves receipt; the
  // executor's claim discipline (integration-pinned: a replay resolves the
  // same attempt, never a second dispatch) covers any repeated decide.
  await waitSettled(page);
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  return { card, briefTitle };
}

// Desktop-only: these pin persisted-outcome hydration, not layout - the
// per-viewport rendering is already pinned by the success journey above.
test("a terminal provider failure settles failed and the reloaded card says so [desktop]", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.CANVA_IMPORT_PROVIDER !== "fixture", "fixture import journey needs CANVA_IMPORT_PROVIDER=fixture");
  await page.setViewportSize({ width: 1440, height: 900 });
  const artifact = await seedArtifact(`${SOURCE_TITLE} [fail]`, SOURCE_TEXT);
  test.skip(!artifact, "DATABASE_URL not configured");
  const accountAlias = await seedCanvaAccount("fail");
  test.skip(!accountAlias, "DATABASE_URL not configured");
  const dispatchSecret = process.env.OUTBOX_DISPATCH_SECRET;
  test.skip(!dispatchSecret, "OUTBOX_DISPATCH_SECRET not configured");

  const { card } = await approveHandOff(page, artifact!.id, accountAlias!);
  await expect(
    card.getByRole("status").filter({ hasText: "Import job created; Polymath is waiting for Canva's terminal result." }),
  ).toBeVisible({ timeout: 30_000 });

  const response = await page.request.post("/api/internal/cron", {
    headers: { authorization: `Bearer ${dispatchSecret}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { reconciled?: number };
  expect(body.reconciled ?? 0).toBeGreaterThanOrEqual(1);

  const settled = await latestImportAttempt();
  expect(settled?.status).toBe("failed");
  expect(settled?.error_code).toBe("canva_import_failed");

  // Reloaded from the decided filter, the card speaks the persisted failure
  // for a person - the stored machine code is translated - and a decided
  // card offers no way to fire again.
  await page.goto("/reviews?status=approved");
  await expect(page).toHaveURL(/status=approved/);
  const decided = page.locator("section").filter({ hasText: accountAlias! });
  await expect(decided.getByText("Not imported. Canva reported the import failed.")).toBeVisible({ timeout: 30_000 });
  await expect(decided.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/feature-pixels/design-brief-fixture-failed-desktop.png", style: HIDE_DEV_CHROME, fullPage: true });
});

test("a job Canva never answers stays UNKNOWN and the reloaded card keeps waiting [desktop]", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.CANVA_IMPORT_PROVIDER !== "fixture", "fixture import journey needs CANVA_IMPORT_PROVIDER=fixture");
  await page.setViewportSize({ width: 1440, height: 900 });
  const artifact = await seedArtifact(`${SOURCE_TITLE} [pending]`, SOURCE_TEXT);
  test.skip(!artifact, "DATABASE_URL not configured");
  const accountAlias = await seedCanvaAccount("pending");
  test.skip(!accountAlias, "DATABASE_URL not configured");
  const dispatchSecret = process.env.OUTBOX_DISPATCH_SECRET;
  test.skip(!dispatchSecret, "OUTBOX_DISPATCH_SECRET not configured");

  const { card } = await approveHandOff(page, artifact!.id, accountAlias!);
  await expect(
    card.getByRole("status").filter({ hasText: "Import job created; Polymath is waiting for Canva's terminal result." }),
  ).toBeVisible({ timeout: 30_000 });

  // The sweep asks, the job answers in_progress: nothing settles.
  const response = await page.request.post("/api/internal/cron", {
    headers: { authorization: `Bearer ${dispatchSecret}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { reconciled?: number };
  expect(body.reconciled ?? 0).toBe(0);

  const attempt = await latestImportAttempt();
  expect(attempt?.status).toBe("unknown");
  expect(attempt?.error_code).toBe("import_in_progress");

  // Reloaded, the persisted waiting line stands - no fake terminal state.
  await page.goto("/reviews?status=approved");
  await expect(page).toHaveURL(/status=approved/);
  await expect(
    page.locator("section").filter({ hasText: accountAlias! }).getByText("Import job created; Polymath is waiting for Canva's terminal result."),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/feature-pixels/design-brief-fixture-pending-desktop.png", style: HIDE_DEV_CHROME, fullPage: true });
});

test("a lost creation answer stays UNKNOWN, makes no provider call, and the reloaded card says so [desktop]", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.CANVA_IMPORT_PROVIDER !== "fixture", "fixture import journey needs CANVA_IMPORT_PROVIDER=fixture");
  await page.setViewportSize({ width: 1440, height: 900 });
  const artifact = await seedArtifact(`${SOURCE_TITLE} [ambiguous]`, SOURCE_TEXT);
  test.skip(!artifact, "DATABASE_URL not configured");
  const accountAlias = await seedCanvaAccount("ambiguous");
  test.skip(!accountAlias, "DATABASE_URL not configured");
  const dispatchSecret = process.env.OUTBOX_DISPATCH_SECRET;
  test.skip(!dispatchSecret, "OUTBOX_DISPATCH_SECRET not configured");

  const { card } = await approveHandOff(page, artifact!.id, accountAlias!);
  // No import_started: the creation answer was lost, so the honest line is
  // the unproven one - and the job-less attempt never gets a provider read.
  await expect(
    card.getByRole("status").filter({ hasText: "Outcome unconfirmed; Polymath checks with Canva before anything runs again." }),
  ).toBeVisible({ timeout: 30_000 });

  const attempt = await latestImportAttempt();
  expect(attempt?.status).toBe("unknown");
  expect(attempt?.provider_object_id).toBeNull();

  const response = await page.request.post("/api/internal/cron", {
    headers: { authorization: `Bearer ${dispatchSecret}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { reconciled?: number };
  expect(body.reconciled ?? 0).toBe(0);

  const after = await latestImportAttempt();
  expect(after?.status).toBe("unknown");
  expect(after?.provider_object_id).toBeNull();

  await page.goto("/reviews?status=approved");
  await expect(page).toHaveURL(/status=approved/);
  await expect(
    page.locator("section").filter({ hasText: accountAlias! }).getByText("Outcome unconfirmed; Polymath checks with Canva before anything runs again."),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/feature-pixels/design-brief-fixture-ambiguous-desktop.png", style: HIDE_DEV_CHROME, fullPage: true });
});
