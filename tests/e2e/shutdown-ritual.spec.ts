import { expect, test, type Page, type TestInfo } from "@playwright/test";
import postgres from "postgres";

/*
 * ASH-305 integration gate: the REAL shutdown route, under the real shell,
 * reached by real navigation from Today, driving the real server action
 * against the same Postgres the server reads. Runs ALONE in its own CI step
 * (SHUTDOWN_RITUAL_E2E=1): applying a real shutdown mutates shared workspace
 * state, which the parallel main suite must never observe mid-run.
 *
 * Two serial journeys, each at its OWN viewport from the start: resizing
 * across the mobile breakpoint remounts the page and discards client state,
 * so a desktop journey resized to mobile proves nothing about mobile. Each
 * journey ends by RELOADING the route (the remount case, ASH-323): the page
 * must show the saved confirmation for the already-closed day, not a fresh
 * form whose empty apply would duplicate the log. A third test then drives a
 * deliberate no-effect repeat and asserts the single-log invariant.
 *
 * ISOLATION: refuses to write against anything but an explicitly isolated
 * database (the CI scratch axiom_e2e, or a name containing e2e, test, or scratch).
 *
 * CLEANUP: every owned row deleted by exact id - seeded captures, sessions,
 * the log artifacts and their day pins (ids from each confirmation's "Open
 * the log" href) - plus tomorrow-seed rows by exact snapshot diff (their
 * targets are suite-leftover tasks; never a workspace-wide sweep). The
 * idempotency receipt and audit rows stay: the product's own record of this
 * exact fixture action, keyed to it, read by no journey surface, and they
 * die with the scratch container.
 */

const captureIds: string[] = [];
const sessionIds: string[] = [];
const logArtifactIds: string[] = [];
let workspaceId: string | null = null;
let preExistingSeedIds = new Set<string>();

function connection(): string | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env: stay unseeded and let the caller skip.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

function isIsolatedDatabase(url: string): boolean {
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return /e2e|test|scratch/i.test(name);
  } catch {
    return false;
  }
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  const url = connection();
  if (!url || !isIsolatedDatabase(url)) return;
  const client = postgres(url, { max: 1 });
  try {
    if (workspaceId) {
      const seeds = await client<{ id: string }[]>`select id from briefing_seeds where workspace_id = ${workspaceId}`;
      for (const row of seeds) {
        if (!preExistingSeedIds.has(row.id)) await client`delete from briefing_seeds where id = ${row.id}`;
      }
    }
    for (const id of logArtifactIds) {
      // artifact_versions cascades from artifacts; pins must go first (RESTRICT).
      await client`delete from day_artifact_pins where artifact_id = ${id}`;
      await client`delete from artifacts where id = ${id}`;
    }
    for (const id of captureIds) await client`delete from captures where id = ${id}`;
    for (const id of sessionIds) await client`delete from focus_sessions where id = ${id}`;
  } finally {
    await client.end();
  }
});

async function journey(
  page: Page,
  testInfo: TestInfo,
  viewport: { name: string; width: number; height: number },
  expectClosed: boolean,
): Promise<void> {
  const url = connection();
  test.skip(!url, "no database configured");
  test.skip(!isIsolatedDatabase(url!), "refusing to write shutdown artifacts outside an isolated test database");

  // The viewport is set BEFORE first paint: a mid-journey resize remounts the
  // page and discards form and confirmation state.
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  // Provision the dev owner the way the other journeys rely on.
  await page.goto("/command-center/inbox");

  const marker = `e2e-shutdown-${viewport.name}-${Date.now()}`;
  const client = postgres(url!, { max: 1 });
  const [owner] = await client<{ workspace_id: string }[]>`
    select m.workspace_id
    from memberships m
    join users u on u.id = m.user_id
    where u.clerk_user_id = 'dev-user' and m.status = 'active'
    limit 1
  `;
  test.skip(!owner, "dev owner not provisioned");
  if (!workspaceId) {
    workspaceId = owner.workspace_id;
    const pre = await client<{ id: string }[]>`select id from briefing_seeds where workspace_id = ${workspaceId}`;
    preExistingSeedIds = new Set(pre.map((r) => r.id));
  }

  // A parkable inbox capture (open state, unparked) and a live focus session
  // the ritual must ask about, never close silently. (The isolated database
  // holds no other live session; the serial mode keeps the two journeys apart.)
  const [cap] = await client<{ id: string }[]>`
    insert into captures (workspace_id, kind, source, raw_payload, text, processing_state)
    values (${workspaceId}, 'text', 'quick_capture', ${client.json({ text: marker })}, ${`Park me ${marker}`}, 'unprocessed')
    returning id
  `;
  captureIds.push(cap.id);
  const [sess] = await client<{ id: string }[]>`
    insert into focus_sessions (workspace_id, subject, state, started_at)
    values (${workspaceId}, ${`Live session ${marker}`}, 'running', now())
    returning id
  `;
  sessionIds.push(sess.id);

  // Real shell, real navigation: the day record -> Shut down.
  await page.goto("/command-center/shutdown");
  await expect(page).toHaveURL(/\/command-center\/shutdown$/);
  // The shell keeps the previous page's h1 mounted through the transition; target the heading itself.
  await expect(page.getByRole("heading", { name: "Shut down" })).toBeVisible();

  if (expectClosed) {
    // An earlier journey already closed this day: the page must surface the
    // saved confirmation (server truth), and a second close is a deliberate,
    // explicit choice - not the default form.
    await expect(page.getByText("This day is already closed.")).toBeVisible();
    await page.getByRole("button", { name: "Close the day again" }).click();
  }

  // The seeded live session is offered with an explicit choice. The previous
  // page's theatre shows the same session, so anchor on the form's radiogroup.
  const sessionPanel = page.getByRole("radiogroup", { name: "What happens to the open session" }).locator("..");
  await expect(sessionPanel.getByText(`Live session ${marker}`)).toBeVisible();
  await page.getByRole("radio", { name: "Finish it" }).click();
  await page.getByLabel("Outcome").fill(`Outcome ${marker}`);

  // Park the seeded capture; Playwright scrolls the long form for real.
  await page.getByRole("checkbox", { name: `Park me ${marker}` }).check();

  await page.screenshot({ path: testInfo.outputPath(`shutdown-real-${viewport.name}-form.png`), fullPage: true });

  await page.getByRole("button", { name: "Close the day" }).click();

  // The confirmation reports exactly what happened and hands back the log id.
  await expect(page.getByText("Day closed")).toBeVisible();
  await expect(page.getByText("Focus session: finish")).toBeVisible();
  await expect(page.getByText("1 capture parked")).toBeVisible();
  const logHref = await page.getByRole("link", { name: "Open the log" }).getAttribute("href");
  const logId = logHref ? new URL(logHref, "http://localhost").searchParams.get("id") : null;
  expect(logId).toBeTruthy();
  logArtifactIds.push(logId!);

  await page.screenshot({ path: testInfo.outputPath(`shutdown-real-${viewport.name}-done.png`), fullPage: true });

  // Database truth: the capture is parked and the session finished with the
  // stated outcome - the actions ran, not just the form.
  const [parked] = await client<{ parked_at: string | null }[]>`
    select parked_at from captures where id = ${cap.id}
  `;
  expect(parked.parked_at).not.toBeNull();
  const [finished] = await client<{ state: string; outcome: string | null }[]>`
    select state, outcome from focus_sessions where id = ${sess.id}
  `;
  expect(finished.state).toBe("finished");
  expect(finished.outcome).toBe(`Outcome ${marker}`);

  // The remount case (ASH-323): reloading re-renders from the server preview,
  // which reports the day as already closed - the saved confirmation with the
  // SAME log, not a fresh form inviting a duplicate apply.
  await page.reload();
  await expect(page.getByText("This day is already closed.")).toBeVisible();
  const closedHref = await page.getByRole("link", { name: "Open the log" }).getAttribute("href");
  expect(closedHref).toContain(logId);

  await client.end();
}

test("the shutdown ritual closes a real day end to end [desktop]", async ({ page }, testInfo) => {
  test.skip(!process.env.SHUTDOWN_RITUAL_E2E, "sequential-only journey; set SHUTDOWN_RITUAL_E2E=1 to run it alone");
  await journey(page, testInfo, { name: "desktop", width: 1280, height: 720 }, false);
});

test("the shutdown ritual closes a real day end to end [mobile]", async ({ page }, testInfo) => {
  test.skip(!process.env.SHUTDOWN_RITUAL_E2E, "sequential-only journey; set SHUTDOWN_RITUAL_E2E=1 to run it alone");
  await journey(page, testInfo, { name: "mobile", width: 390, height: 844 }, true);
});

test("a no-effect repeat apply replays the existing log instead of duplicating it", async ({ page }) => {
  test.skip(!process.env.SHUTDOWN_RITUAL_E2E, "sequential-only journey; set SHUTDOWN_RITUAL_E2E=1 to run it alone");
  const url = connection();
  test.skip(!url || !workspaceId, "needs the journeys' workspace");
  // One log per journey above, each with real effects.
  expect(logArtifactIds).toHaveLength(2);

  // Reopen the closed day and apply with NOTHING new selected: the server
  // must replay the existing log, not write a third one (ASH-323).
  await page.goto("/command-center/shutdown");
  await page.getByRole("button", { name: "Close the day again" }).click();
  await page.getByRole("button", { name: "Close the day" }).click();
  await expect(page.getByText("This day is already closed.")).toBeVisible();
  const href = await page.getByRole("link", { name: "Open the log" }).getAttribute("href");
  const replayedId = href ? new URL(href, "http://localhost").searchParams.get("id") : null;
  expect(replayedId).toBeTruthy();
  expect(logArtifactIds).toContain(replayedId);

  const client = postgres(url!, { max: 1 });
  const logs = await client<{ n: number }[]>`
    select count(*)::int as n from artifacts
    where workspace_id = ${workspaceId} and title like 'Shutdown log %'
  `;
  expect(logs[0].n).toBe(2);
  await client.end();
});
