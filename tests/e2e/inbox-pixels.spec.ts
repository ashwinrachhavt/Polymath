import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * Pixel coverage for the inbox filter tabs. The tab count readout is a
 * decoration on the tab's name (aria-hidden) rendered at full-strength
 * muted-foreground - an opacity cut on bg-muted put it under WCAG 2.2 AA
 * (2.77:1), which the smoke axe suite now gates. These captures keep the
 * actual control on record for both viewports.
 *
 * Pixels land in feature-pixels.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function createTextCapture(page: import("@playwright/test").Page, text: string): Promise<void> {
  const response = await page.request.post("/api/v1/captures", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { text },
  });
  expect(response.status(), await response.text()).toBe(201);
}

for (const vp of VIEWPORTS) {
  test(`the inbox filter tabs render with legible count readouts [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });

    await page.goto("/alfred"); // provisions the dev owner before seeding
    await waitSettled(page);

    // Unique namespace per attempt: the inbox is a shared dev workspace, so
    // the counts are workspace-global and only the tabs themselves are
    // asserted, not their numbers.
    const nonce = crypto.randomUUID().slice(0, 8);
    await createTextCapture(page, `e2e-inbox-tabs-${nonce} first`);
    await createTextCapture(page, `e2e-inbox-tabs-${nonce} second`);

    await page.goto("/command-center/inbox");
    await waitSettled(page);
    await page.addStyleTag({ content: HIDE_DEV_CHROME });

    await expect(page.getByRole("link", { name: "To clarify" })).toBeVisible();
    await expect(page.getByRole("link", { name: "All", exact: true })).toBeVisible();

    await page.screenshot({ path: `test-results/feature-pixels/inbox-filter-tabs-${vp.name}.png` });
  });
}
