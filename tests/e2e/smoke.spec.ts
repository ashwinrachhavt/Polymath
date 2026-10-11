import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/*
 * The scaffold's one journey: the app boots, it is keyboard-reachable, and it
 * is accessible at the level design.md sets as a quality floor rather than a
 * phase. Every later journey test adds to this file's neighbours, not to it.
 */

test("the app opens on the briefing", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/briefing");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Briefing");
});

test("every destination is reachable from the rail and has one heading", async ({ page }) => {
  await page.goto("/briefing");
  const nav = page.getByRole("navigation", { name: "Destinations" }).first();

  for (const label of [
    "Inbox",
    "Work",
    "Focus",
    "Alfred",
    "Reviews",
    "Knowledge",
    "Relationships",
    "Opportunities",
    "Dossiers",
    "Activity",
    "Settings",
  ]) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(label);
  }
});

test("an unmatched address offers a way back", async ({ page }) => {
  await page.goto("/nothing-here");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await page.getByRole("link", { name: "Back to the briefing" }).click();
  await expect(page).toHaveURL("/briefing");
});

test("the destinations meet WCAG 2.2 AA", async ({ page }) => {
  for (const path of ["/briefing", "/inbox", "/work", "/alfred", "/reviews", "/settings"]) {
    await page.goto(path);
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations, `violations on ${path}`).toEqual([]);
  }
});
