import { expect, test } from "@playwright/test";
import { removeSeededProposals, seedNotionAppendProposal } from "./helpers/proposals";

/*
 * Pixels for the Notion diff review card (ASH-283): the owner approves the
 * exact lines a Notion append will add, with the content hash the executor
 * re-checks. Seeded with the production preview shape (appendPreview); the
 * product cannot propose one on demand without a connected Notion account.
 *
 * Screenshots land in test-results/feature-pixels/ and upload as the
 * feature-pixels CI artifact. Each viewport seeds its own titled proposal so
 * the fullyParallel siblings never assert on each other's cards.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.afterAll(async () => {
  await removeSeededProposals();
});

for (const vp of VIEWPORTS) {
  test(`a Notion append reviews as the exact diff [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const seeded = await seedNotionAppendProposal({
      title: `Launch notes (${vp.name})`,
      before: ["# Launch notes", "", "Beta opens Tuesday", "Feedback to #launch", "", "Pricing unchanged"],
      addition: ["## Rollout", "", "GA on November 3", "Status page updated first"],
    });
    test.skip(!seeded, "DATABASE_URL not configured");

    await page.goto("/reviews");
    // The proposal title, then the diff card: where it lands, the hash the
    // executor re-checks, the tail context, and the added lines.
    // The card shows the title in both the heading and the effect line;
    // the heading is the unambiguous handle.
    await expect(page.getByRole("heading", { name: `Append 4 lines to \u201cLaunch notes (${vp.name})\u201d in Notion` })).toBeVisible({ timeout: 30_000 });
    // Shared strings match the sibling viewport's card too; .first() is the
    // honest scope, matching the pattern the other pixel journeys use.
    await expect(page.getByText("Added to the end of").first()).toBeVisible();
    await expect(page.getByRole("link", { name: `Launch notes (${vp.name})` })).toBeVisible();
    await expect(page.getByText("Pricing unchanged").first()).toBeVisible();
    await expect(page.getByText("GA on November 3").first()).toBeVisible();
    await expect(page.getByText("Status page updated first").first()).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/notion-diff-card-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });
}
