import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * The Activity rail reads the workspace's real audit events - the read
 * surface recordAudit never had while the rail rendered the browser-local
 * preview log. One journey writes a real event through the calendar's
 * add-block action (the same recordAudit path every domain uses) and reads
 * it back on /activity; a second pins workspace isolation.
 */
function db() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

test("an audit event written by a real action lands on the activity rail", async ({ page }) => {
  test.setTimeout(120_000);
  const client = db();
  const tag = `activity-e2e-${Date.now().toString(36)}`;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");

    await page.goto("/neuralflow/work?view=calendar");
    await page.getByRole("button", { name: "+ Add block" }).click();
    await page.locator('input[name="title"]').fill(tag);
    const today = new Date().toISOString().slice(0, 10);
    await page.locator('input[name="day"]').fill(today);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    // The form closes only after the server action commits.
    await expect(page.locator('input[name="title"]')).toBeHidden();

    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText(`Created event "${tag}"`)).toBeVisible();
    // Pixel evidence for review: the real feed on desktop and mobile widths.
    await page.screenshot({ path: "test-results/feature-pixels/activity-feed-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(`Created event "${tag}"`)).toBeVisible();
    await page.screenshot({ path: "test-results/feature-pixels/activity-feed-mobile.png", fullPage: true });
  } finally {
    if (client) {
      await client`delete from events where title = ${tag}`;
      await client`delete from audit_events where summary like ${"%" + tag + "%"}`;
      await client.end();
    }
  }
});

test("the activity rail never shows another workspace's events", async ({ page }) => {
  test.setTimeout(60_000);
  const client = db();
  const tag = `foreign-activity-${Date.now().toString(36)}`;
  let seededId: string | null = null;
  let seededWorkspaceId: string | null = null;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    const [owner] = await client!<{ workspace_id: string }[]>`
      select m.workspace_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    test.skip(!owner, "dev workspace not found");
    // The CI database has exactly one workspace, so seed a throwaway foreign
    // one instead of skipping: the isolation claim must actually execute.
    const [other] = await client!<{ id: string }[]>`
      insert into workspaces (name, slug) values (${`Foreign e2e ${tag}`}, ${`foreign-e2e-${tag}`}) returning id`;
    seededWorkspaceId = other!.id;
    const [row] = await client!<{ id: string }[]>`
      insert into audit_events (workspace_id, actor_kind, action, subject_type, summary)
      values (${other!.id}, 'user', 'capture.created', 'capture', ${`Foreign event ${tag}`})
      returning id`;
    seededId = row!.id;

    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText(`Foreign event ${tag}`)).toHaveCount(0);
  } finally {
    if (client && seededId) await client`delete from audit_events where id = ${seededId}`;
    if (client && seededWorkspaceId) await client`delete from workspaces where id = ${seededWorkspaceId}`;
    await client?.end();
  }
});

test("private supervisor thread events never render on the activity rail", async ({ page }) => {
  test.setTimeout(60_000);
  const client = db();
  const tag = `private-thread-${Date.now().toString(36)}`;
  let seededId: string | null = null;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    const [owner] = await client!<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    test.skip(!owner, "dev workspace not found");
    // The same shape supervisor/respond.ts writes for a private exchange.
    const [row] = await client!<{ id: string }[]>`
      insert into audit_events (workspace_id, actor_id, actor_kind, action, subject_type, summary)
      values (${owner!.workspace_id}, ${owner!.user_id}, 'user', 'conversation.navigation_answered', 'thread', ${`Navigation answered in-thread: note search "${tag}"`})
      returning id`;
    seededId = row!.id;

    await page.goto("/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText(tag)).toHaveCount(0);
  } finally {
    if (client && seededId) await client`delete from audit_events where id = ${seededId}`;
    await client?.end();
  }
});

test("a deep link highlights its event, and an unknown id says so honestly", async ({ page }) => {
  test.setTimeout(60_000);
  const client = db();
  const tag = `deep-link-${Date.now().toString(36)}`;
  let seededId: string | null = null;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    const [owner] = await client!<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    test.skip(!owner, "dev workspace not found");
    const [row] = await client!<{ id: string }[]>`
      insert into audit_events (workspace_id, actor_id, actor_kind, action, subject_type, summary)
      values (${owner!.workspace_id}, ${owner!.user_id}, 'user', 'capture.created', 'capture', ${`Deep link capture ${tag}`})
      returning id`;
    seededId = row!.id;

    await page.goto(`/activity?event=${row!.id}`);
    const target = page.locator('li[data-deep-linked="true"]');
    await expect(target).toHaveCount(1);
    await expect(target).toContainText(`Deep link capture ${tag}`);

    // An unknown (or invisible) id renders the honest note, never a fake row.
    await page.goto(`/activity?event=${crypto.randomUUID()}`);
    await expect(page.getByRole("note")).toContainText("That event is not available");
  } finally {
    if (client && seededId) await client`delete from audit_events where id = ${seededId}`;
    await client?.end();
  }
});

test("a grouped conversion renders one outcome row with a steps disclosure", async ({ page }) => {
  test.setTimeout(60_000);
  const client = db();
  const tag = `grouped-${Date.now().toString(36)}`;
  const noteTitle = `Grouped note ${tag}`;
  let captureId: string | null = null;
  let noteId: string | null = null;
  let outcomeId: string | null = null;
  let stepId: string | null = null;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    const [owner] = await client!<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    test.skip(!owner, "dev workspace not found");
    const workspaceId = owner!.workspace_id;
    const [capture] = await client!<{ id: string }[]>`
      insert into captures (workspace_id, kind, raw_payload, capture_mode, text, title)
      values (${workspaceId}, 'text', '{}', 'authored', ${`Convert me ${tag}`}, ${`Grouped capture ${tag}`})
      returning id`;
    captureId = capture!.id;
    const [note] = await client!<{ id: string }[]>`
      insert into artifacts (workspace_id, kind, title)
      values (${workspaceId}, 'note', ${noteTitle})
      returning id`;
    noteId = note!.id;
    const operationId = crypto.randomUUID();
    // The payload-v1 shape the conversion commands write: outcome first, the
    // proposal-acceptance step a minute older, sharing one operationId.
    const [outcome] = await client!<{ id: string }[]>`
      insert into audit_events (workspace_id, actor_id, actor_kind, action, subject_type, subject_id, operation_id, summary, metadata)
      values (${workspaceId}, ${owner!.user_id}, 'user', 'capture.converted', 'capture', ${capture!.id}, ${operationId}, ${`Capture became note: ${noteTitle}`},
        ${JSON.stringify({ version: 1, resultType: "note", resultId: note!.id, displaySnapshot: { title: noteTitle } })}::jsonb)
      returning id`;
    outcomeId = outcome!.id;
    const [step] = await client!<{ id: string }[]>`
      insert into audit_events (workspace_id, actor_id, actor_kind, action, subject_type, subject_id, operation_id, summary, created_at)
      values (${workspaceId}, ${owner!.user_id}, 'user', 'capture.proposal_accepted', 'capture', ${capture!.id}, ${operationId}, ${`Capture proposal accepted ${tag}`}, now() - interval '1 minute')
      returning id`;
    stepId = step!.id;

    await page.goto("/activity");
    // The outcome renders as one sentence; the step is folded underneath.
    // Row-scoped: other real conversions in the shared QA database render the
    // same sentence, so assertions anchor to this test's own outcome row.
    const outcomeRow = page.locator("main li").filter({ hasText: noteTitle });
    await expect(outcomeRow).toHaveCount(1);
    await expect(outcomeRow).toContainText("You converted a capture");
    await expect(outcomeRow).toContainText(noteTitle);
    await expect(outcomeRow).toContainText("Show 1 recorded step");
    await expect(page.getByText(`Capture proposal accepted ${tag}`)).toBeHidden();
    // The note chip carries the verified destination.
    await expect(page.locator(`a[href$="/polymath/notes?id=${noteId}"]`).first()).toBeVisible();

    // Deep-linking the step row highlights the outcome and opens its steps.
    await page.goto(`/activity?event=${stepId}`);
    await expect(page.locator(`li[data-deep-linked="true"]`)).toContainText("You converted a capture");
    await expect(page.getByText(`Capture proposal accepted ${tag}`)).toBeVisible();
  } finally {
    const ids = [outcomeId, stepId].filter(Boolean);
    if (client) {
      if (ids.length) await client!`delete from audit_events where id in ${client!(ids)}`;
      if (noteId) await client`delete from artifacts where id = ${noteId}`;
      if (captureId) await client`delete from captures where id = ${captureId}`;
      await client.end();
    }
  }
});

test("Load more walks the keyset cursor to the end of a 55-row feed", async ({ page }) => {
  test.setTimeout(120_000);
  const client = db();
  const tag = `loadmore-${Date.now().toString(36)}`;
  const count = 55;
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    const [owner] = await client!<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    test.skip(!owner, "dev workspace not found");
    // One multi-row insert: 55 technical-free, activity-visible rows.
    await client!`
      insert into audit_events (workspace_id, actor_id, actor_kind, action, subject_type, summary, created_at)
      select ${owner!.workspace_id}, ${owner!.user_id}, 'user', 'capture.created', 'capture', ${"Load more " + tag} || ' ' || g,
        now() - g * interval '1 second'
      from generate_series(1, ${count}) g`;

    await page.goto(`/activity?q=${encodeURIComponent(`Load more ${tag}`)}`);
    // Row-scoped: the toolbar echoes the query ("Search: …"), so a bare
    // text= locator counts the chrome too.
    const entries = page.locator("main li").filter({ hasText: `Load more ${tag}` });
    await expect(entries).toHaveCount(50);
    // The keyset peek cannot know the exact remaining count, so the link is
    // plainly "Load more" (see page.tsx).
    await page.getByRole("link", { name: "Load more" }).click();
    await expect(entries).toHaveCount(55);
  } finally {
    if (client) {
      await client`delete from audit_events where summary like ${"Load more " + tag + "%"}`;
      await client.end();
    }
  }
});
