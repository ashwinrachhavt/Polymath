import { expect, test } from "@playwright/test";

/*
 * Review pixels for the onboarding surfaces (ASH-296), captured against the
 * dev-only fixture route (see its page.tsx for why the real /onboarding
 * cannot render these states in the harness). Each state renders the same
 * component the page branch renders, in the same wrapper.
 *
 * The artifacts land in test-results/onboarding-pixels/ and upload as the
 * onboarding-pixels CI artifact for review. The interaction states —
 * assist pending, assist failed, confirm conflict — are driven here against
 * the REAL server actions: the fixture route's confirm always loses the
 * version guard (profileVersion -1), so a conflict is the DB telling the
 * truth, and the assist is staged at the transport (aborted or dangled
 * POST), which is exactly the failure surface a dead network gives a user.
 */

const HIDE_DEV_CHROME = { style: "nextjs-portal { display: none }" } as const;

/*
 * First-hit dev compiles are the slow step on a cold server: the fixture
 * route, the wizard chunk, and the underlying pages each take tens of
 * seconds to compile on first request, and the 30s defaults read that as a
 * test failure (QA F10 — 3 specs failed cold, passed warm, zero code
 * changes). Both ceilings ride up together: the goto timeouts so the
 * compile itself waits, the test timeout so the goto's headroom exists.
 */
test.setTimeout(240_000);

const GOTO = { timeout: 90_000, waitUntil: "domcontentloaded" } as const;

/*
 * The wizard is an async client chunk: the DOM paints well before React
 * attaches, so a click that lands in that gap does nothing and every
 * downstream assertion reads a pre-hydration page. networkidle waits for
 * the chunk graph to settle, which is the hydration gate.
 */
async function settle(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
}

const states = [
  {
    state: "fresh",
    verify: async (page: import("@playwright/test").Page) => {
      await expect(page.getByRole("heading", { name: "What do you do?" })).toBeVisible();
    },
  },
  {
    state: "s1",
    verify: async (page: import("@playwright/test").Page) => {
      // The draft arrived: the role input is prefilled, Continue already on.
      await expect(page.getByRole("textbox", { name: /Your role/ })).toHaveValue(
        "Founder at a two-person climate studio",
      );
    },
  },
  {
    state: "s2",
    verify: async (page: import("@playwright/test").Page) => {
      await expect(page.getByRole("heading", { name: "Tools and what matters" })).toBeVisible();
    },
  },
  {
    state: "s3",
    verify: async (page: import("@playwright/test").Page) => {
      await expect(page.getByRole("textbox", { name: "In your own words" })).toBeVisible();
    },
  },
  {
    state: "review",
    verify: async (page: import("@playwright/test").Page) => {
      await expect(page.getByRole("heading", { name: "Is this right?" })).toBeVisible();
    },
  },
  {
    state: "salvage",
    verify: async (page: import("@playwright/test").Page) => {
      await expect(page.getByText(/The interview could not finish/i)).toBeVisible();
    },
  },
  {
    state: "welcome",
    verify: async (page: import("@playwright/test").Page) => {
      await expect(page.getByText(/Your agent is ready/i)).toBeVisible();
    },
  },
] as const;

for (const { state, verify } of states) {
  test(`onboarding ${state} state renders`, async ({ page }) => {
    await page.goto(`/dev/onboarding-fixtures?state=${state}`, GOTO);
    // The welcome (and any motion-mounted state) paints at opacity 0 until
    // hydration attaches; assert and capture only after the chunk settles.
    await settle(page);
    await verify(page);
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    // The entrance motion (4px rise + fade) runs on mount; capture after it
    // settles or the pixel shows the pre-fade frame.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/onboarding-pixels/${state}.png`, fullPage: true, ...HIDE_DEV_CHROME });
  });
}

test("a role choice unlocks the tools step", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=fresh", GOTO);
  await page.getByRole("heading", { name: "What do you do?" }).waitFor();
  await settle(page);
  // The role chips are pressed buttons in the house pill idiom.
  await page.getByRole("button", { name: "Founder or executive" }).click();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Tools and what matters" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/onboarding-pixels/advance-to-tools.png",
    fullPage: true,
    ...HIDE_DEV_CHROME,
  });
});

test("the assist pending state is a quiet status line, not a spinner", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=s3", GOTO);
  await page.getByRole("textbox", { name: "In your own words" }).waitFor();
  await settle(page);
  // Dangle every server-action POST: the request never answers, so the
  // wizard sits in its pending state for as long as the transport does.
  await page.route("**/dev/onboarding-fixtures**", (route) =>
    route.request().method() === "POST" ? new Promise(() => {}) : route.continue(),
  );
  await page.getByRole("button", { name: /Polish with Polymath/ }).click();
  await expect(page.getByText(/Reading your answers/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: "test-results/onboarding-pixels/s3-assist-pending.png",
    fullPage: true,
    ...HIDE_DEV_CHROME,
  });
});

test("a failed assist shows a labelled error and keeps the draft", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=s3", GOTO);
  const wordsBox = page.getByRole("textbox", { name: "In your own words" });
  await wordsBox.waitFor();
  await settle(page);
  const words = await wordsBox.inputValue();
  // Abort the transport: the assist fetch throws, and the wizard owes the
  // person a labelled error — with their words exactly where they left them.
  await page.route("**/dev/onboarding-fixtures**", (route) =>
    route.request().method() === "POST" ? route.abort("connectionreset") : route.continue(),
  );
  await page.getByRole("button", { name: /Polish with Polymath/ }).click();
  await expect(page.getByText(/The assist could not be reached/)).toBeVisible({ timeout: 15_000 });
  await expect(wordsBox).toHaveValue(words);
  await page.screenshot({
    path: "test-results/onboarding-pixels/s3-assist-failed.png",
    fullPage: true,
    ...HIDE_DEV_CHROME,
  });
});

test("confirm on the fixture route loses the version race and keeps the draft", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=review", GOTO);
  await page.getByRole("heading", { name: "Is this right?" }).waitFor();
  await settle(page);
  await page.getByRole("button", { name: /Confirm and start/ }).click();
  await expect(page.getByText(/changed in another tab/)).toBeVisible({ timeout: 15_000 });
  // The draft survives: the review fields still hold what the brief proposed.
  await expect(page.getByRole("textbox", { name: "What should your agent be called?" })).toHaveValue("Polymath");
  await page.screenshot({
    path: "test-results/onboarding-pixels/review-conflict.png",
    fullPage: true,
    ...HIDE_DEV_CHROME,
  });
});
