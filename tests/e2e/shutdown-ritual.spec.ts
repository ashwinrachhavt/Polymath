import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * ASH-305 integration gate: the REAL shutdown route, under the real shell,
 * reached by real navigation from Today, driving the real server action
 * against the same Postgres the server reads. The seeded-fixture screenshots
 * only proved layout; this spec proves route + nav + scroll + data actions
 * end to end, and returns real-route desktop/mobile pixels as artifacts.
 *
 * ISOLATION: this spec writes log artifacts and day pins, so unlike the
 * lighter seeding journeys it refuses to run against anything but an
 * explicitly isolated database: the CI scratch instance (axiom_e2e) or a
 * database whose name marks it as test/scratch. A shared local or user
 * database makes the spec skip, never write.
 *
 * CLEANUP: every row this run writes is deleted by its exact fixture-owned
 * id - the seeded capture and session, plus the shutdown log artifact, its
 * versions, and its day pin, whose id the confirmation's "Open the log"
 * link hands back directly. No time-bounded sweeps.
 */

const marker = `e2e-shutdown-${Date.now()}`;

let workspaceId: string | null = null;
let captureId: string | null = null;
let sessionId: string | null = null;
let logArtifactId: string | null = null;

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

test.afterAll(async () => {
  const url = connection();
  if (!url || !isIsolatedDatabase(url)) return;
  const client = postgres(url, { max: 1 });
  try {
    if (logArtifactId) {
      // artifact_versions cascades from artifacts; pins must go first.
      await client`delete from day_artifact_pins where artifact_id = ${logArtifactId}`;
      await client`delete from artifacts where id = ${logArtifactId}`;
    }
    if (captureId) await client`delete from captures where id = ${captureId}`;
    if (sessionId) await client`delete from focus_sessions where id = ${sessionId}`;
  } finally {
    await client.end();
  }
});

test("the shutdown ritual closes a real day end to end", async ({ page }, testInfo) => {
  const url = connection();
  test.skip(!url, "no database configured");
  test.skip(!isIsolatedDatabase(url!), "refusing to write shutdown artifacts outside an isolated test database");

  // Provision the dev owner the way the other journeys rely on.
  await page.goto("/command-center/briefing");

  const client = postgres(url!, { max: 1 });
  const [owner] = await client<{ workspace_id: string }[]>`
    select m.workspace_id
    from memberships m
    join users u on u.id = m.user_id
    where u.clerk_user_id = 'dev-user' and m.status = 'active'
    limit 1
  `;
  test.skip(!owner, "dev owner not provisioned");
  workspaceId = owner.workspace_id;

  // A parkable inbox capture (open state, unparked).
  const [cap] = await client<{ id: string }[]>`
    insert into captures (workspace_id, kind, source, raw_payload, text, processing_state)
    values (${workspaceId}, 'text', 'quick_capture', ${client.json({ text: marker })}, ${`Park me ${marker}`}, 'unprocessed')
    returning id
  `;
  captureId = cap.id;

  // A live focus session the ritual must ask about, never close silently.
  // (The isolated database holds no other session.)
  const [sess] = await client<{ id: string }[]>`
    insert into focus_sessions (workspace_id, subject, state, started_at)
    values (${workspaceId}, ${`Live session ${marker}`}, 'running', now())
    returning id
  `;
  sessionId = sess.id;

  // Real shell, real navigation: Today -> Shut down.
  await page.goto("/command-center/briefing");
  await page.getByRole("link", { name: "Shut down" }).click();
  await expect(page).toHaveURL(/\/command-center\/briefing\/shutdown$/);
  // The shell keeps the previous page's h1 mounted through the transition; target the heading itself.
  await expect(page.getByRole("heading", { name: "Shut down" })).toBeVisible();

  // The seeded live session is offered with an explicit choice.
  // The shell keeps the previous page (Today, with its own session block for the
  // same live session) mounted through the transition; anchor on the form's
  // radiogroup and assert within its panel.
  const sessionPanel = page.getByRole("radiogroup", { name: "What happens to the open session" }).locator("..");
  await expect(sessionPanel.getByText(`Live session ${marker}`)).toBeVisible();
  await page.getByRole("radio", { name: "Finish it" }).click();
  await page.getByLabel("Outcome").fill(`Outcome ${marker}`);

  // Park the seeded capture; Playwright scrolls the long form for real.
  await page.getByRole("checkbox", { name: `Park me ${marker}` }).check();

  // Real-route pixels, desktop form first: the filled ritual before apply.
  await page.screenshot({ path: testInfo.outputPath("shutdown-real-desktop-form.png"), fullPage: true });

  await page.getByRole("button", { name: "Close the day" }).click();

  // The confirmation reports exactly what happened and hands back the log id.
  await expect(page.getByText("Day closed")).toBeVisible();
  await expect(page.getByText("Focus session: finish")).toBeVisible();
  await expect(page.getByText("1 capture parked")).toBeVisible();
  const logHref = await page.getByRole("link", { name: "Open the log" }).getAttribute("href");
  logArtifactId = logHref ? new URL(logHref, "http://localhost").searchParams.get("id") : null;
  expect(logArtifactId).toBeTruthy();

  // Real-route pixels: desktop confirmation, then the same state at a phone
  // viewport (client state survives the resize, so this is the done panel).
  await page.screenshot({ path: testInfo.outputPath("shutdown-real-desktop-done.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("shutdown-real-mobile-done.png"), fullPage: true });

  // Database truth: the capture is parked and the session finished with the
  // stated outcome - the actions ran, not just the form.
  const [parked] = await client<{ parked_at: string | null }[]>`
    select parked_at from captures where id = ${captureId!}
  `;
  expect(parked.parked_at).not.toBeNull();
  const [finished] = await client<{ state: string; outcome: string | null }[]>`
    select state, outcome from focus_sessions where id = ${sessionId!}
  `;
  expect(finished.state).toBe("finished");
  expect(finished.outcome).toBe(`Outcome ${marker}`);

  await client.end();
});
