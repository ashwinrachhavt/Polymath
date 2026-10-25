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

const states = [
  { state: "confirm", ready: (page: import("@playwright/test").Page) => page.getByRole("button", { name: /confirm/i }) },
  { state: "status", ready: (page: import("@playwright/test").Page) => page.getByText(/agent runtime is not reachable/i) },
  { state: "form", ready: (page: import("@playwright/test").Page) => page.getByRole("button", { name: /continue/i }) },
  {
    state: "form-salvage",
    ready: (page: import("@playwright/test").Page) => page.getByText(/summary could not be read/i),
  },
] as const;

for (const { state, ready } of states) {
  test(`onboarding ${state} state renders`, async ({ page }) => {
    await page.goto(`/dev/onboarding-fixtures?state=${state}`);
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
  await page.goto("/dev/onboarding-fixtures?state=island-success");
  await expect(page.getByText("what would make tomorrow morning feel different?")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await page.screenshot({ path: "test-results/onboarding-pixels/island-conversation.png", fullPage: true, ...HIDE_DEV_CHROME });
});

test("the island settles on a labelled failure surface when no runtime is reachable", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=island");
  // The island mounts and starts its run. How far it gets depends on the
  // harness env: no bridge secret fails the start outright (the island's own
  // error card); a secret without a reachable Eve starts the run and the
  // stream answers with a labelled error inside the chat. Both are the
  // bridge-down journey - the assertion is a named failure, never a spinner
  // or an error boundary.
  await expect(
    page.getByText(/could not start|not reachable|no agent session|execution is unavailable/i).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await page.screenshot({ path: "test-results/onboarding-pixels/island-settled.png", fullPage: true, ...HIDE_DEV_CHROME });
});
