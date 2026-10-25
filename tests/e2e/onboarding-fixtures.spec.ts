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

test("the island settles on the status card when no runtime is reachable", async ({ page }) => {
  await page.goto("/dev/onboarding-fixtures?state=island");
  // The island mounts and starts its run; without EVE_BASE_URL the start
  // fails fast and the island swaps to the status card. Give the transition
  // room, then assert the settled surface, not a spinner.
  await expect(page.getByText(/could not start|not reachable/i).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "test-results/onboarding-pixels/island-settled.png", fullPage: true, ...HIDE_DEV_CHROME });
});
