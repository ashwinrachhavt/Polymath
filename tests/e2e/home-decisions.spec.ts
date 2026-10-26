import { expect, test } from "@playwright/test";
import { removeSeededProposals, seedAgentProposal, seedCaptureProposal } from "./helpers/proposals";
import { waitSettled } from "./helpers/settled";

/*
 * ASH-309: the root surface is the decision engine. A seeded agent proposal
 * and a capture classification land in one ranked queue; each card shows its
 * exact effect, reason and risk; approve and reject decide in one tap and
 * the queue drains. Pixels land in feature-pixels for both viewports.
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
  test(`the homepage is a ranked decision queue [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    await page.goto("/alfred"); // provisions the dev owner before seeding
    await waitSettled(page);

    const agent = await seedAgentProposal({
      title: `Send the launch note ${vp.name}`,
      effect: "Sends one email to priya@example.com.",
      riskClass: "external_write",
    });
    test.skip(!agent, "DATABASE_URL not configured");
    const capture = await seedCaptureProposal({ text: `Water the plants before the trip ${vp.name}`, kind: "task" });
    expect(capture).not.toBeNull();

    await page.goto("/");
    await waitSettled(page);
    await expect(page.locator("#content h1")).toHaveText("Decisions");

    // The agent's external write outranks the capture's prepare.
    const cards = page.getByRole("list", { name: "Decisions waiting on you" }).getByRole("listitem");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText(`Send the launch note ${vp.name}`);
    await expect(cards.nth(0)).toContainText("Sends one email to priya@example.com.");
    await expect(cards.nth(0)).toContainText("Writes outside");
    await expect(cards.nth(1)).toContainText(`Water the plants before the trip ${vp.name}`);
    await expect(cards.nth(1)).toContainText("Becomes a task.");
    await expect(cards.nth(1)).toContainText("Capture read");

    await page.addStyleTag({ content: HIDE_DEV_CHROME });
    await page.screenshot({ path: `test-results/feature-pixels/home-decisions-${vp.name}.png` });

    // One-tap reject on the capture read; the queue drains to the agent card.
    await cards.nth(1).getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.getByRole("list", { name: "Decisions waiting on you" }).getByRole("listitem")).toHaveCount(1);

    // One-tap approve on the agent proposal; the empty state is designed, not a hole.
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Nothing needs your decision.", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/home-decisions-empty-${vp.name}.png` });
  });
}
