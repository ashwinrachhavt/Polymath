import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { destinations } from "../../src/lib/navigation";
import { removeSeededRuns, seedRun } from "./helpers/runs";
import { waitSettled } from "./helpers/settled";

test.afterAll(async () => {
  await removeSeededRuns();
});

test("the root opens the conversation", async ({ page }) => {
  // The old canonical-routes tour collected pageerrors across its root visit;
  // when the tour split into per-route tests, the visit and its net moved here
  // — the one test that owns the root.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  // The conversation is home. The decision queue that used to hold this route
  // lives in the header's notifications panel now, so "/" redirects rather
  // than rendering a queue nobody reaches by typing the root.
  await expect(page).toHaveURL(/\/polymath$/);
  await expect(page.locator("#content h1")).toHaveText("What would you like to work on?");
  // The Assistant reads canonical runs; the preview banner must not claim otherwise.
  await expect(page.getByText("Interactive preview", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

/*
 * The home is a conversation surface now: greeting, one composer, then history.
 * The copy that described the old run-launcher screen must be gone from the
 * rendered page, not merely absent from the source — a stale branch in a
 * conditional would still ship it.
 */
test("the Assistant home carries only the new conversation copy", async ({ page }) => {
  await page.goto("/polymath");
  await expect(page.locator("#content h1")).toHaveText("What would you like to work on?");
  const composer = page.getByRole("textbox", { name: "Start a conversation" });
  await expect(composer).toHaveAttribute("placeholder", "Ask anything or describe a task…");

  const body = page.locator("body");
  for (const gone of [
    "Hand off work and inspect what it did",
    "Start a run",
    "No threads yet",
    "Recent runs",
    "You:",
    "Assistant:",
  ]) {
    await expect(body, gone).not.toContainText(gone);
  }
});

test("the rail leads with the conversation, then Inbox", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/polymath");
  // The home streams: the shell hydrates and the Suspense boundary swaps its
  // content in. Reading the DOM before that settles throws "Execution context
  // was destroyed, most likely because of a navigation" — the page was still
  // replacing itself, not changing route.
  await waitSettled(page);
  // Destination links carry their label as an accessible name; the wordmark's
  // name comes from its visible text, so it does not match a[aria-label] and is
  // excluded by the query itself.
  // Retried, not read once: the rail mounts with the shell, and waitSettled can
  // return before it is in the DOM, which made a one-shot read see no links.
  // Decisions left the rail when its queue moved into the notifications panel.
  await expect
    .poll(async () =>
      await page
        .getByRole("navigation", { name: "Workspace", exact: true })
        .locator("a[aria-label]")
        .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")).slice(0, 3)),
    )
    .toEqual(["Polymath", "Inbox", "Work"]);
});

/*
 * The canonical routes. The unit layer tests the navigation lib; these
 * journeys prove the routes themselves render — a broken destinationForPath,
 * shell, or dropped page file fails here. One named test per route (split
 * from a single serial tour): a red route fails alone and the routes'
 * dev-compiles parallelize across workers instead of queueing behind the
 * tour. The root redirect that preceded the loop is asserted by "the root
 * opens the conversation", which owns that visit.
 */
for (const [path, heading] of [
  ["/neuralflow/work", "Work"],
  ["/polymath/knowledge", "Knowledge"],
  ["/more", "More"],
] as const) {
  test(`canonical route ${path} renders`, async ({ page }) => {
    // One visit per test; the ceiling only bites when dev-compile contention
    // (parallel first compiles on one dev server) stretches a cold route.
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("#content h1"), path).toContainText(heading);
    expect(errors).toEqual([]);
  });
}

/*
 * Every rail destination is a real screen, one named test per destination
 * (split from a single serial tour over the same array — a new or removed
 * destination changes this family with it, so no destination can silently
 * lose coverage). A broken shell or dropped page file fails here.
 */
for (const destination of destinations) {
  test(`rail destination ${destination.label} (${destination.href}) is a real screen`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const response = await page.goto(destination.href);
    expect(response?.status(), destination.href).toBe(200);
    // Route-level loading.tsx renders a second skeleton <main>; scope to
    // the shell's content main so navigation never races the skeleton.
    await expect(page.locator("#content h1")).toHaveCount(1);
    await expect(page.locator("#content")).not.toContainText("Nothing is here");
    // Scope to the aria-labeled destination link: the rail's wordmark is also
    // a link whose accessible name is "Polymath" (from its visible text), and
    // since b5b1d26 renamed the first destination to Polymath a plain
    // getByRole('link', name) collides between the two.
    await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByLabel(destination.label, { exact: true })).toHaveAttribute("aria-current", "page");
    expect(errors).toEqual([]);
  });
}

test("the launcher lists destinations", async ({ page }) => {
  await page.goto("/command-center/inbox");
  await page.getByRole("button", { name: "Open destinations" }).click();
  const launcher = page.getByRole("dialog");
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole("link", { name: "Work", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeHidden();
});

/*
 * Shared, unprefixed routes render under the same shell (no redirect to
 * /apps). One named test per route, split from the launcher tour.
 */
for (const shared of ["/reviews", "/settings", "/activity"]) {
  test(`shared route ${shared} renders under the shell`, async ({ page }) => {
    const response = await page.goto(shared);
    expect(response?.status(), shared).toBe(200);
    await expect(page).not.toHaveURL(/^https?:\/\/[^/]*\/apps\//);
  });
}

test("the destination launcher is keyboard reachable and closes on escape", async ({ page }) => {
  await page.goto("/neuralflow/work");
  const trigger = page.getByRole("button", { name: "Open destinations" });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

/*
 * A run row on home is a conversation, not a status board: the objective and
 * its age, nothing else. The waiting-on-you vocabulary lives in Reviews by
 * design (see the run page's comment), so no status words belong on the row.
 * `waiting_approval` is only reachable after a model asks for a proposal, so
 * the row is seeded directly.
 */
test("a run row on home names the objective, and nothing else", async ({ page }) => {
  const objective = `Approve the renewal letter ${Date.now().toString(36)}`;
  const run = await seedRun({ objective, state: "waiting_approval" });
  test.skip(!run, "Seeding a waiting run needs DATABASE_URL.");

  await page.goto("/polymath");
  const row = page.getByRole("link", { name: new RegExp(objective) });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("href", `/polymath/${run!.id}`);
  // No status vocabulary on the row: Reviews owns "needs you", and internal
  // state names are never the words of the screen.
  for (const status of ["Needs your reply", "Running", "In progress", "Queued", "Succeeded", "waiting_approval"]) {
    await expect(row, status).not.toContainText(status);
  }
  // The row is a conversation, not a debug line: no model, no transcript prefix.
  await expect(row).not.toContainText("You:");
  await expect(row).not.toContainText("Assistant:");
});

/*
 * The conversation page: the transcript is the page, controls live under it,
 * and a run id that is not this workspace's is the same answer as one that
 * never existed. The shell's loading.tsx commits before notFound() runs, so
 * the response is 200 with not-found content — assert the content, never the
 * status.
 */
test("a run opens its conversation, with controls under the transcript", async ({ page }) => {
  const objective = `Draft the renewal letter ${Date.now().toString(36)}`;
  const run = await seedRun({ objective, state: "waiting_approval" });
  test.skip(!run, "Opening a conversation needs DATABASE_URL.");

  await page.goto(`/polymath/${run!.id}`);
  // The streaming shell can leave the streamed subtree mounted twice in dev;
  // every locator below is scoped to the first content main so strict mode
  // sees one page.
  const content = page.locator("#content").first();
  await expect(content.locator("h1")).toHaveText(objective);
  const conversation = content.getByRole("region", { name: "Conversation" });
  await expect(conversation).toBeVisible();
  await expect(conversation.getByText("This conversation has no messages yet.")).toBeVisible();
  // Approvals are decided in Reviews; that surface owns the waiting-on-you
  // vocabulary, so the conversation page grows no status badge of its own.
  await expect(content.getByText("Needs your reply")).toHaveCount(0);

  // A waiting run is live from the page's point of view: the composer offers a
  // follow-up and a stop, and the draft control (nothing produced yet) stays
  // out of the way.
  await expect(conversation.getByRole("textbox", { name: "Follow-up message" })).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Save the answer as a draft" })).toHaveCount(0);
});

test("a finished run shows its retry and draft controls instead of a composer", async ({ page }) => {
  const objective = `Summarize the vendor terms ${Date.now().toString(36)}`;
  const run = await seedRun({ objective, state: "succeeded" });
  test.skip(!run, "Opening a conversation needs DATABASE_URL.");

  await page.goto(`/polymath/${run!.id}`);
  const content = page.locator("#content").first();
  await expect(content.locator("h1")).toHaveText(objective);
  const conversation = content.getByRole("region", { name: "Conversation" });
  await expect(conversation).toBeVisible();
  // A finished run keeps its stored transcript (empty here) and takes Retry;
  // the live composer and its cancel button are gone.
  await expect(conversation.getByText("This conversation has no messages yet.")).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Retry as a new run" })).toBeVisible();
  await expect(conversation.getByRole("textbox", { name: "Follow-up message" })).toHaveCount(0);
  // With no output to keep, the draft control renders nothing.
  await expect(conversation.getByRole("button", { name: "Save the answer as a draft" })).toHaveCount(0);
});

test("a conversation that does not exist says so, without a 404 page", async ({ page }) => {
  await page.goto("/polymath/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
  // A malformed id takes the same path as a missing one, never a uuid cast error.
  await page.goto("/polymath/not-a-uuid");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
});

test("the old /work path redirects to the tasks screen", async ({ page }) => {
  await page.goto("/work");
  await expect(page).toHaveURL("/apps/neuralflow/tasks");
});

test("unknown apps screens render a noindex not-found state", async ({ page }) => {
  // The shell's loading.tsx commits before notFound() runs, so the response
  // is 200 with not-found content — assert the content, never the status.
  const response = await page.goto("/apps/polymath/not-a-screen");
  expect([200, 404]).toContain(response?.status());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

/*
 * The IA simplification removed seven rail destinations. Six keep a redirect
 * bridge to the screen that absorbed their function (query params dropped,
 * except the notebook bridge, whose ?id= is the Notes surface's own deep link
 * and so is carried across); Learning's route was deleted entirely, so its
 * address 404s with the same noindex not-found state as any unknown screen.
 * One named test per pair, generated from the same table the single tour
 * walked, so a bridge that breaks fails alone and none can be dropped.
 */
for (const [from, to] of [
  ["/polymath/sources", "/projects"],
  ["/polymath/dossiers", "/projects"],
  ["/polymath/wiki", "/polymath/knowledge"],
  ["/command-center/briefing", "/neuralflow/work?view=today"],
  ["/command-center/opportunities", "/command-center/relationships/people"],
  ["/neuralflow/focus", "/neuralflow/work"],
] as const) {
  test(`removed IA destination ${from} redirects to ${to}`, async ({ page }) => {
    await page.goto(`${from}?stale=param`);
    // Briefing's bridge drops the query on purpose: the stale param is from a
    // surface that no longer reads it, and forwarding it would land Work on an
    // unknown view. Everything else keeps its params.
    if (to.includes("?")) {
      await expect(page, from).toHaveURL(new RegExp(to.replace("?", "\\?") + "$"));
    } else {
      await expect(page, from).toHaveURL(to);
    }
  });
}

// The old notebook address keeps the note deep link it once owned.
test("the old notebook address keeps its note deep link", async ({ page }) => {
  await page.goto("/polymath/notebook?id=00000000-0000-4000-8000-000000000001");
  await expect(page).toHaveURL("/polymath/notes?id=00000000-0000-4000-8000-000000000001");
});

test("the removed Learning route 404s with a noindex not-found state", async ({ page }) => {
  await page.goto("/polymath/learning");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

/*
 * Representative product screens, one axe scan per screen (split from a
 * single tour): a red screen fails alone and the scans parallelize across
 * workers. Same tags, same settled-page wait, same assertions per screen.
 * The notebook leg scans the canonical surface (B04); its rich-editor
 * toolbar only mounts with a note open, so no editor landmark here. The
 * artifacts leg scans the rail's kept-outputs list (IA simplification).
 */
for (const path of ["/command-center/inbox", "/settings", "/neuralflow/work", "/polymath/knowledge", "/polymath/notes", "/polymath/artifacts"]) {
  test(`${path} meets WCAG 2.2 AA`, async ({ page }) => {
    // An axe scan plus a cold dev-compile per screen; the ceiling only bites
    // when compile contention on the shared dev server stretches a leg.
    test.setTimeout(120_000);
    await page.goto(path);
    // Axe must evaluate the settled page: the topbar buttons sit at
    // disabled:opacity-50 until hydration and transition to full opacity,
    // and axe composites whatever it samples through in-flight opacity.
    await waitSettled(page);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations, path).toEqual([]);
  });
}

/*
 * /reviews must be scanned POPULATED: an empty queue once hid a serious
 * definition-list violation on the pinned-sender proposal card. Seed one
 * pending proposal with a pinned sender so the card's real markup renders —
 * the same seed the single tour ran before it reached this leg. Without
 * DATABASE_URL the scan still runs on the empty queue, as before.
 */
test("/reviews meets WCAG 2.2 AA", async ({ page }) => {
  test.setTimeout(120_000);
  const client = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
  const tag = `wcag-${Date.now().toString(36)}`;
  let seededProposalId: string | null = null;
  try {
    if (client) {
      const [owner] = await client<{ workspace_id: string }[]>`
        select m.workspace_id from memberships m join users u on u.id = m.user_id
        where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
      if (owner) {
        const [proposal] = await client<{ id: string }[]>`
          insert into action_proposals (workspace_id, capability, risk_class, status, title, expected_effect, dedupe_key, account_alias)
          values (${owner.workspace_id}, 'send_mail', 'external_write', 'pending', ${`WCAG seed ${tag}`}, 'Sends one prepared message.', ${tag}, 'e2e')
          returning id`;
        seededProposalId = proposal!.id;
        await client`
          insert into action_revisions (workspace_id, proposal_id, revision_number, payload)
          values (${owner.workspace_id}, ${seededProposalId}, 1, ${JSON.stringify({
            accountPin: { resolved: true, sender: "e2e-sender@example.com" },
            to: "recipient@example.invalid",
            subject: `WCAG seed ${tag}`,
          })})`;
      }
    }
    await page.goto("/reviews");
    // Axe must evaluate the settled page: the topbar buttons sit at
    // disabled:opacity-50 until hydration and transition to full opacity,
    // and axe composites whatever it samples through in-flight opacity.
    await waitSettled(page);
    // The populated proposal card's real pixels: axe proves semantics, not
    // spacing or readability, so the seeded /reviews card is captured too.
    if (seededProposalId) {
      await expect(page.getByText(`WCAG seed ${tag}`, { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: "test-results/feature-pixels/reviews-populated-desktop.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: "test-results/feature-pixels/reviews-populated-mobile.png" });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations, "/reviews").toEqual([]);
  } finally {
    if (client && seededProposalId) await client`delete from action_proposals where id = ${seededProposalId}`;
    await client?.end();
  }
});

test("mobile exposes the destinations bar without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/more");
  await expect(page.locator("#content h1")).toContainText("More");
  await expect(page.getByRole("navigation", { name: "Destinations", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
