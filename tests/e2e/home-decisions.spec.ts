import { expect, test } from "@playwright/test";
import { removeSeededProposals, seedAgentProposal, seedCaptureProposal } from "./helpers/proposals";
import { waitSettled } from "./helpers/settled";

/*
 * The decision queue moved from the root page into the header's notifications
 * panel: "/" redirects to the conversation now, and a decision is answered
 * where it interrupts, not on a page of its own. The invariants ASH-309 pinned
 * are unchanged - both proposers land in one ranked queue, each card states its
 * exact effect and risk, and deciding drains it - so this spec drives the same
 * journey through the panel.
 *
 * Pixels land in feature-pixels for both viewports.
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
  test(`the notifications panel is a ranked decision queue [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    await page.goto("/alfred"); // provisions the dev owner before seeding
    await waitSettled(page);

    // Titles are unique per attempt: specs share the dev workspace with
    // parallel workers, so every assertion below scopes to these two cards
    // instead of workspace-global counts or the global empty state.
    const nonce = crypto.randomUUID().slice(0, 8);
    const agentTitle = `Send the launch note ${vp.name} ${nonce}`;
    const captureText = `Water the plants before the trip ${vp.name} ${nonce}`;
    const agent = await seedAgentProposal({
      title: agentTitle,
      effect: "Sends one email to priya@example.com.",
      riskClass: "external_write",
    });
    test.skip(!agent, "DATABASE_URL not configured");
    const capture = await seedCaptureProposal({ text: captureText, kind: "task" });
    expect(capture).not.toBeNull();

    await page.goto("/neuralflow/work?view=today");
    await waitSettled(page);

    // The panel is chrome: it exists on every destination but is closed until
    // asked for, so nothing here is on screen by default.
    const trigger = page.getByRole("button", { name: /^Notifications/ });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.getByRole("navigation", { name: "Notification kinds" })).toBeVisible();

    // Both proposers are in the queue, on the Decisions tab.
    await page.getByRole("button", { name: /^Decisions/ }).click();

    // The agent's external write outranks the capture's prepare. Ranking is
    // the relative position of our two cards; foreign cards from parallel
    // specs can sit anywhere in the queue without bearing on it.
    const cards = page.getByRole("dialog").getByRole("listitem");
    await expect
      .poll(async () => {
        const texts = await cards.allTextContents();
        const agentIdx = texts.findIndex((t) => t.includes(agentTitle));
        const captureIdx = texts.findIndex((t) => t.includes(captureText));
        return agentIdx >= 0 && captureIdx > agentIdx;
      })
      .toBe(true);

    const agentCard = cards.filter({ hasText: agentTitle }).first();
    const captureCard = cards.filter({ hasText: captureText }).first();
    await expect(agentCard).toContainText("Sends one email to priya@example.com.");
    await expect(agentCard).toContainText("Waiting on you");
    await expect(captureCard).toContainText("Becomes a task.");

    await page.addStyleTag({ content: HIDE_DEV_CHROME });
    await page.screenshot({ path: `test-results/feature-pixels/notifications-decisions-${vp.name}.png` });

    // One-tap reject on the capture read, one-tap approve on the agent
    // proposal: each decides its own card and the queue drains them.
    await captureCard.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(captureCard).toHaveCount(0);
    await agentCard.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(agentCard).toHaveCount(0);
    await page.screenshot({ path: `test-results/feature-pixels/notifications-decisions-drained-${vp.name}.png` });
  });
}

test("the root sends the owner to the conversation", async ({ page }) => {
  await page.goto("/");
  await waitSettled(page);
  await expect(page).toHaveURL(/\/alfred$/);
});
