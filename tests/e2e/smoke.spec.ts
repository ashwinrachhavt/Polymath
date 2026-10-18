import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { products, productHref } from "../../src/lib/products";
import { waitSettled } from "./helpers/settled";

test("home opens the canonical Command Center briefing", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/apps/command-center/briefing");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Briefing");
  await expect(page.getByText("Interactive preview", { exact: true })).toBeVisible();
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

for (const product of products) {
  test(`${product.name} destinations are real screens`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const destination of product.destinations) {
      const response = await page.goto(productHref(product, destination.slug));
      expect(response?.status(), destination.slug).toBe(200);
      // Route-level loading.tsx renders a second skeleton <main>; scope to
      // the shell's content main so navigation never races the skeleton.
      await expect(page.locator("#content h1")).toHaveCount(1);
      await expect(page.locator("#content")).not.toContainText("Nothing is here");
      await expect(page.getByRole("navigation", { name: "Destinations", exact: true }).getByRole("link", { name: destination.label, exact: true })).toHaveAttribute("aria-current", "page");
    }
    expect(errors).toEqual([]);
  });
}

test("switch products without forking a captured task", async ({ page }) => {
  await page.goto("/apps/command-center/briefing");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const capture = page.getByRole("dialog");
  await capture.getByRole("button", { name: "Task", exact: true }).click();
  await capture.getByRole("textbox", { name: "Capture content" }).fill("Parity journey task");
  await capture.getByRole("button", { name: "Save capture" }).click();
  await expect(capture).toBeHidden();
  await page.getByRole("button", { name: "Switch product" }).click();
  await page.getByRole("dialog").getByRole("link").filter({ hasText: "NeuralFlow" }).click();
  await page.goto("/apps/neuralflow/tasks");
  await expect(page.locator("#content")).toContainText("Parity journey task");
  await page.reload();
  await expect(page.locator("#content")).toContainText("Parity journey task");
  await page.goto("/apps/command-center/work");
  await expect(page.locator("#content")).toContainText("Parity journey task");
});

test("command search is keyboard reachable and handles empty results", async ({ page }) => {
  await page.goto("/apps/neuralflow/tasks");
  await expect(page.getByRole("button", { name: "Capture", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Search workspace" })).toBeFocused();
  await dialog.getByRole("textbox").fill("no-matching-record-xyz");
  await expect(dialog).toContainText("No results");
  await dialog.getByRole("textbox").fill("Notebook");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/apps/alfred/notebook");
  await expect(dialog).toBeHidden();
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

test("mobile exposes all product screens without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/more");
  await expect(page.getByRole("heading", { name: "All screens" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile destinations" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Switch product" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Switch product" })).toBeFocused();
});
