import { expect, test } from "@playwright/test";

/*
 * The onboarding gate from the outside.
 *
 * The full journey (conversation -> confirm card -> /alfred) needs a live Eve
 * runtime, which the e2e harness does not have; the run/spend/session
 * semantics live in tests/integration/onboarding-flow.test.ts and the
 * extraction contract in tests/unit/onboarding-brief.test.ts. What this suite
 * owns is the gate itself: an onboarded workspace has nothing to do on
 * /onboarding and is sent home, and the route renders without a server error
 * for whoever does land there.
 *
 * The shared dev workspace is provisioned already-onboarded (global-setup),
 * and no spec may flip that marker: parallel suites read it on every gated
 * page they visit.
 */

test("an onboarded workspace is sent home from /onboarding", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/alfred$/);
  // Home, not an error boundary.
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
});
