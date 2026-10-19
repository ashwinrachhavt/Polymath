import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { apps, destinationsIn } from "../../src/lib/navigation";
import { waitSettled } from "./helpers/settled";

test("home opens the canonical Command Center briefing", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/command-center/briefing");
  await expect(page.locator("#content h1")).toContainText("Briefing");
  // The briefing reads canonical tasks; the preview banner must not claim otherwise.
  await expect(page.getByText("Interactive preview", { exact: true })).toHaveCount(0);
});

/*
 * The canonical three-app routes: the IA this branch delivers. The unit layer
 * tests the navigation lib; this journey proves the routes themselves render —
 * a broken appForPath, shell, or dropped page file fails here.
 */
test("canonical app routes render", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveURL("/command-center/briefing");
  await expect(page.locator("#content h1")).toContainText("Briefing");

  for (const [path, heading] of [
    ["/neuralflow/work", "Work"],
    ["/alfred/knowledge", "Knowledge"],
    ["/more", "More"],
  ] as const) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("#content h1"), path).toContainText(heading);
  }
  expect(errors).toEqual([]);
});

for (const app of apps) {
  test(`${app.label} destinations are real screens`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const destination of destinationsIn(app.slug)) {
      const response = await page.goto(destination.href);
      expect(response?.status(), destination.href).toBe(200);
      // Route-level loading.tsx renders a second skeleton <main>; scope to
      // the shell's content main so navigation never races the skeleton.
      await expect(page.locator("#content h1")).toHaveCount(1);
      await expect(page.locator("#content")).not.toContainText("Nothing is here");
      await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: destination.label, exact: true })).toHaveAttribute("aria-current", "page");
    }
    expect(errors).toEqual([]);
  });
}

test("the launcher crosses apps and shared routes are reachable", async ({ page }) => {
  await page.goto("/command-center/briefing");
  await page.getByRole("button", { name: "Switch product" }).click();
  const launcher = page.getByRole("dialog");
  await expect(launcher).toBeVisible();
  // Cross-app links out of Command Center target the other two apps.
  await expect(launcher.getByRole("link").filter({ hasText: "NeuralFlow" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeHidden();
  // Shared, unprefixed routes render under the same shell (no redirect to /apps).
  for (const shared of ["/reviews", "/settings", "/activity"]) {
    const response = await page.goto(shared);
    expect(response?.status(), shared).toBe(200);
    await expect(page).not.toHaveURL(/^https?:\/\/[^/]*\/apps\//);
  }
});

test("the app launcher is keyboard reachable and closes on escape", async ({ page }) => {
  await page.goto("/neuralflow/work");
  const trigger = page.getByRole("button", { name: "Switch product" });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("old Axiom paths redirect and unknown screens render a noindex not-found state", async ({ page }) => {
  await page.goto("/work");
  await expect(page).toHaveURL("/apps/neuralflow/tasks");
  const response = await page.goto("/apps/alfred/not-a-screen");
  expect([200, 404]).toContain(response?.status());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("representative product screens meet WCAG 2.2 AA", async ({ page }) => {
  test.setTimeout(120_000);
  for (const path of ["/apps/command-center/briefing", "/apps/command-center/reviews", "/apps/command-center/settings", "/apps/neuralflow/tasks", "/apps/neuralflow/focus", "/apps/alfred/library", "/apps/alfred/notebook"]) {
    await page.goto(path);
    // Axe must evaluate the settled page: the topbar buttons sit at
    // disabled:opacity-50 until hydration and transition to full opacity,
    // and axe composites whatever it samples through in-flight opacity.
    await waitSettled(page, path === "/apps/alfred/notebook" ? { heading: "Heading" } : {});
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations, path).toEqual([]);
  }
});

test("mobile exposes the apps bar without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/more");
  await expect(page.locator("#content h1")).toContainText("More");
  await expect(page.getByRole("navigation", { name: "Apps", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
