import { expect, test } from "@playwright/test";

/*
 * Review pixels for the onboarding surfaces (ASH-296), captured against the
 * dev-only fixture route (see its page.tsx for why the real /onboarding
 * cannot render these states in the harness). Each state renders the same
 * component the page branch renders, in the same wrapper.
 *
 * The artifacts land in test-results/onboarding-pixels/ and upload as the
 * onboarding-pixels CI artifact for review. The `island` shot is the one
 * state that touches the server: the island auto-starts its run, which fails
 * fast to the status card in the keyless harness (no Eve) - that transition
 * IS the bridge-down journey, so the settled card is asserted as well.
 */

const HIDE_DEV_CHROME = { style: "nextjs-portal { display: none }" } as const;

/*
 * First-hit dev compiles are the slow step on a cold server: the fixture
 * route, the island chunk, and the underlying pages each take tens of seconds
 * to compile on first request, and the 30s defaults read that as a test
 * failure (QA F10 — 3 specs failed cold, passed warm, zero code changes).
 * Both ceilings ride up together: the goto timeouts so the compile itself
 * waits, the test timeout so the goto's headroom exists. The ceiling must
 * cover the worst case in one test — goto(90s) plus the island test's 5s
 * evidence pause plus its 60s settle — so 240s, not merely the goto's 90.
 */
test.setTimeout(240_000);

const GOTO = { timeout: 90_000 } as const;

const states = [
  { state: "confirm", ready: (page: import("@playwright/test").Page) => page.getByRole("button", { name: /confirm/i }) },
  { state: "status", ready: (page: import("@playwright/test").Page) => page.getByText(/agent runtime is not reachable/i) },
  { state: "form", ready: (page: import("@playwright/test").Page) => page.getByRole("button", { name: /start working/i }) },
  {
    state: "form-salvage",
    ready: (page: import("@playwright/test").Page) => page.getByText(/summary could not be read/i),
  },
] as const;

for (const { state, ready } of states) {
  test(`onboarding ${state} state renders`, async ({ page }) => {
    await page.goto(`/dev/onboarding-fixtures?state=${state}`, GOTO);
    await ready(page).first().waitFor();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    await page.screenshot({ path: `test-results/onboarding-pixels/${state}.png`, fullPage: true, ...HIDE_DEV_CHROME });
  });
}

/*
 * The island mid-conversation. The stream endpoint is Eve-backed, so the spec
 * answers it with fabricated ChatFrames (the wire contract from
 * src/domains/agents/stream-contract.ts): a snapshot of the turns so far and
 * the turn marker that leaves the conversation open. What renders is the real
 * ChatSurface and its accumulator - only the transport is staged, which is
 * also why this can never be evidence the Eve path itself works.
 */
test("the island renders a live conversation", async ({ page }) => {
  const frames = [
    {
      type: "snapshot",
      runId: "fixture-success-run",
      blocks: [
        { id: "b1", kind: "user", text: "I'm a solo founder and my inbox runs my day.", done: true },
        {
          id: "b2",
          kind: "assistant",
          text: "That is exactly what I am here to take off your plate. Which tools do you live in - Gmail, Linear, Calendar, something else?",
          done: true,
        },
        { id: "b3", kind: "user", text: "Gmail and Linear, mostly. Calendar for the external meetings.", done: true },
        {
          id: "b4",
          kind: "assistant",
          text: "Got it. Last one: what should I watch first - what would make tomorrow morning feel different?",
          done: true,
        },
      ],
      cursor: 4,
    },
    { type: "turn", runId: "fixture-success-run", state: "waiting", cursor: 5 },
  ];
  await page.route("**/api/v1/runs/fixture-success-run/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    });
  });
  await page.goto("/dev/onboarding-fixtures?state=island-success", GOTO);
  await expect(page.getByText("what would make tomorrow morning feel different?")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await page.screenshot({ path: "test-results/onboarding-pixels/island-conversation.png", fullPage: true, ...HIDE_DEV_CHROME });
});

test("the island settles on a labelled failure surface when no runtime is reachable", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=island", GOTO);
  // Evidence for the state the island is in before it settles: if the start
  // never returns, this is the shot that shows it.
  await page.waitForTimeout(5_000);
  await page.screenshot({ path: "test-results/onboarding-pixels/island-starting.png", fullPage: true, ...HIDE_DEV_CHROME });
  // The island mounts and starts its run. How far it gets depends on the
  // harness env: no bridge secret fails the start outright (the island's own
  // error card); a secret without a reachable Eve starts the run and the
  // stream answers with a labelled error inside the chat. Both are the
  // bridge-down journey - the assertion is a named failure, never a spinner
  // or an error boundary.
  await expect(
    page
      .getByText(
        // The three named bridge-down surfaces, and only those: the island's
        // own error card, the bridge-reason copy, or the stream's labelled
        // failure frame. Anything else failing still fails this test.
        /The interview could not start|not reachable from this deployment|no agent session|Agent execution is unavailable/,
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await page.screenshot({ path: "test-results/onboarding-pixels/island-settled.png", fullPage: true, ...HIDE_DEV_CHROME });
});

/*
 * The page's landing for a failed interview run with nothing salvageable
 * (QA F5): the failure card renders at once, with Retry and the form fallback
 * — and no "Starting the interview…" spinner, because a failed run must never
 * auto-mint a replacement run, session, and spend reservation on reload.
 */
test("a failed run with nothing salvageable lands on the failure card, not an auto-start", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=retry-card", GOTO);
  await expect(page.getByRole("heading", { name: "The interview could not start" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Starting the interview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("button", { name: /answer as a form instead/i })).toBeVisible();
  await page.screenshot({ path: "test-results/onboarding-pixels/retry-card.png", fullPage: true, ...HIDE_DEV_CHROME });
});

/*
 * The terminal failure inside the conversation (QA F6): the real ChatSurface
 * on a run whose stream reports turn failed AND the run ended failed. The
 * failure line must carry the terminal truth with a working fresh-start Retry
 * — never the turn-failure lie ("You can send another message") that no send
 * can satisfy on a closed session.
 */
test("a terminally failed run reconciles the failure line with the ended composer", async ({ page }) => {
  const frames = [
    {
      type: "snapshot",
      runId: "fixture-failed-run",
      blocks: [
        { id: "b1", kind: "user", text: "I'm a solo founder and my inbox runs my day.", done: true },
        { id: "b2", kind: "assistant", text: "Got it. Which tools do you live in?", done: true },
      ],
      cursor: 2,
    },
    { type: "turn", runId: "fixture-failed-run", state: "failed", cursor: 3 },
    { type: "end", runId: "fixture-failed-run", state: "failed", cursor: 3 },
  ];
  await page.route("**/api/v1/runs/fixture-failed-run/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    });
  });
  await page.goto("/dev/onboarding-fixtures?state=island-failed", GOTO);
  // The terminal truth replaces the turn-failure line, and its Retry is the
  // island's fresh start (the same mechanism the error card's Retry uses).
  await expect(page.getByText("This run failed. Retry it to start a new run.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("You can send another message")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  // The composer agrees the run is over: no input, just the honest ended
  // state - the contradiction QA caught (sendable + guarded at once) is gone.
  await expect(page.getByText("This conversation has ended.")).toBeVisible();
  await page.screenshot({
    path: "test-results/onboarding-pixels/island-terminal-failed.png",
    fullPage: true,
    ...HIDE_DEV_CHROME,
  });
});
