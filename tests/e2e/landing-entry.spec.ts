import { expect, test } from "@playwright/test";

/*
 * The landing page's ways in. The page is static, so it cannot know who is
 * reading: every entry is a link the server decides. With Clerk armed the
 * links go to /sign-in or /sign-up, and the proxy shows a signed-out visitor
 * the form and sends a signed-in one straight on (unit-tested in
 * tests/unit/proxy-redirect-chain.test.ts, since this harness runs keyless).
 * Keyless, the workspace is open to the dev owner, so the same links must land
 * in the app; before the fix "Open the app" pointed at a route the proxy
 * bounced straight back to the landing page.
 */

test("Open the app and Get started both land in the app", async ({ page }) => {
  for (const name of ["Open the app", "Get started"]) {
    await page.goto("/landing");
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Read it. Prove it.");
    await page.getByRole("link", { name, exact: true }).first().click();
    await expect(page).toHaveURL(/\/polymath$/);
  }
});

test("a bounced deep link keeps its destination, and only a same-origin one", async ({ page }) => {
  await page.goto(`/landing?returnTo=${encodeURIComponent("/polymath/notes")}`);
  await expect(page.getByRole("link", { name: "Open the app" })).toHaveAttribute("href", "/polymath/notes");

  await page.goto(`/landing?returnTo=${encodeURIComponent("//evil.test/x")}`);
  await expect(page.getByRole("link", { name: "Open the app" })).toHaveAttribute("href", "/polymath");
});

test("the practice question answers without any script", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/landing");
  await page.getByLabel(/Every token is compared with every other token/).check();
  await expect(page.getByText("Right. Doubling the input quadruples the comparisons.")).toBeVisible();
  await page.getByLabel(/The vocabulary grows/).check();
  await expect(page.getByText(/^Not quite\./)).toBeVisible();
  await context.close();
});
