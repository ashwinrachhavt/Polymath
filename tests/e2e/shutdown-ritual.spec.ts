import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * ASH-305 integration gate: the REAL shutdown route, under the real shell,
 * reached by real navigation from Today, driving the real server action
 * against the same Postgres the server reads. The seeded-fixture screenshots
 * only proved layout; this spec proves route + nav + scroll + data actions
 * end to end. The CI e2e database is scratch (migrations applied per run),
 * so no production apply or new authority is involved.
 *
 * Seeds the two states the product cannot produce on demand in a keyless
 * run - a parkable inbox capture and a live focus session - the way the
 * other data-dependent journeys do (helpers/runs.ts pattern), then cleans
 * up everything it wrote, including the shutdown log artifacts.
 */

const marker = `e2e-shutdown-${Date.now()}`;

let workspaceId: string | null = null;
let captureId: string | null = null;
let sessionId: string | null = null;

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

test.afterAll(async () => {
  const url = connection();
  if (!url) return;
  const client = postgres(url, { max: 1 });
  try {
    if (captureId) await client`delete from captures where id = ${captureId}`;
    if (sessionId) await client`delete from focus_sessions where id = ${sessionId}`;
    if (workspaceId) {
      // Only rows this run could have written: time-bounded, marker-day shutdown logs.
      await client`
        delete from day_artifact_pins
        where workspace_id = ${workspaceId}
          and created_at > now() - interval '15 minutes'
      `;
      await client`
        delete from artifact_versions
        where artifact_id in (
          select id from artifacts
          where workspace_id = ${workspaceId}
            and title like 'Shutdown log %'
            and created_at > now() - interval '15 minutes'
        )
      `;
      await client`
        delete from artifacts
        where workspace_id = ${workspaceId}
          and title like 'Shutdown log %'
          and created_at > now() - interval '15 minutes'
      `;
    }
  } finally {
    await client.end();
  }
});

test("the shutdown ritual closes a real day end to end", async ({ page }) => {
  const url = connection();
  test.skip(!url, "no database configured");

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
  // (The CI scratch database holds no other session; on a shared local
  // database an already-live session would surface instead of this one.)
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
  await expect(page.locator("#content h1")).toHaveText("Shut down");

  // The seeded live session is offered with an explicit choice.
  await expect(page.getByText(`Live session ${marker}`)).toBeVisible();
  await page.getByRole("radio", { name: "Finish it" }).click();
  await page.getByLabel("Outcome").fill(`Outcome ${marker}`);

  // Park the seeded capture; Playwright scrolls the long form for real.
  await page.getByRole("checkbox", { name: `Park me ${marker}` }).check();

  await page.getByRole("button", { name: "Close the day" }).click();

  // The confirmation reports exactly what happened.
  await expect(page.getByText("Day closed")).toBeVisible();
  await expect(page.getByText("Focus session: finish")).toBeVisible();
  await expect(page.getByText("1 capture parked")).toBeVisible();

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
