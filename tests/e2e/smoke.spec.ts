import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/*
 * The scaffold's one journey: the app boots, it is keyboard-reachable, and it
 * is accessible at the level design.md sets as a quality floor rather than a
 * phase. Every later journey test adds to this file's neighbours, not to it.
 */

test("the app renders its landing screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Axiom");
});

test("an unmatched address offers a way back", async ({ page }) => {
  await page.goto("/nothing-here");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await page.getByRole("link", { name: "Back to the briefing" }).click();
  await expect(page).toHaveURL("/");
});

test("the landing screen meets WCAG 2.2 AA", async ({ page }) => {
  await page.goto("/");
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(violations).toEqual([]);
});
