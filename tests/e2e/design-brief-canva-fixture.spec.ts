import { expect, test } from "@playwright/test";
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
    const alias = `canva-e2e-fixture-${crypto.randomUUID().slice(0, 8)}`;
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
  const accountSeeded = await seedCanvaAccount();
  test.skip(!accountSeeded, "DATABASE_URL not configured");
  const dispatchSecret = process.env.OUTBOX_DISPATCH_SECRET;
  test.skip(!dispatchSecret, "OUTBOX_DISPATCH_SECRET not configured");

  // Draft the brief and hand it off from the brief page.
  await page.goto(`/artifacts/${artifact!.id}`);
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

  // Approve the exact revision. The fixture accepts the job: the honest
  // outcome is UNKNOWN with the import_started phase, named for a person.
  await page.getByRole("link", { name: "Review in Reviews" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(
    page.getByRole("status").filter({ hasText: "Import job created; Polymath is waiting for Canva's terminal result." }),
  ).toBeVisible({ timeout: 30_000 });

  // Reload from the decided filter: the PERSISTED attempt outcome must say
  // what the decide response said. Async truth that vanishes on reload is no
  // truth at all - the reviewer leaves and comes back.
  await page.goto("/reviews?status=approved");
  await expect(page.getByText("Import job created; Polymath is waiting for Canva's terminal result.")).toBeVisible({
    timeout: 30_000,
  });
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

  // Terminal pixel, reloaded: the card reads the settled attempt row and
  // says the import landed - the same line a fresh decide response would
  // have shown, now server-rendered from persisted state.
  await page.goto("/reviews?status=approved");
  await expect(page.getByText(`Import design brief "${briefTitle}"`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Imported to Canva.")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `test-results/feature-pixels/design-brief-fixture-terminal-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
});
}
