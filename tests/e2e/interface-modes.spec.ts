import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * ASH-312: Library and Action are two interface languages behind one
 * account preference. The journey pins Library in Settings, watches the
 * decision queue re-render in the calm register, flips to Action from the
 * header toggle, and reloads to prove the choice lives on the account, not
 * in the browser. Font assertions read the computed style; pixels land in
 * feature-pixels.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";

async function resolvedMode(page: import("@playwright/test").Page): Promise<string> {
  return page.locator("[data-interface-mode]").first().getAttribute("data-interface-mode") as Promise<string>;
}

test("interface mode is an account preference with two visual languages", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/settings");
  await waitSettled(page, { heading: "Settings" });

  // Skip cleanly where settings is only a browser preview (no sign-in).
  const modeSelect = page.locator('select[name="interfaceMode"]');
  test.skip(!(await modeSelect.count()), "server-saved preferences unavailable on this deployment");

  // Pin Library from Settings; the whole workspace re-renders in it.
  await modeSelect.selectOption("library");
  await page.getByRole("button", { name: "Save interface mode" }).click();
  await expect(page.getByText(/Interface mode saved/)).toBeVisible();

  await page.goto("/");
  await waitSettled(page);
  expect(await resolvedMode(page)).toBe("library");
  const title = page.locator("#content h1");
  await expect(title).toHaveText("Decisions");
  const libraryFont = await title.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(libraryFont).toMatch(/Iowan|Palatino|Georgia/);

  await page.addStyleTag({ content: HIDE_DEV_CHROME });
  await page.screenshot({ path: "test-results/feature-pixels/interface-library.png" });

  // One tap in the header pins Action; the register tightens.
  await page.getByRole("button", { name: "Switch to Action mode" }).click();
  await expect.poll(() => resolvedMode(page)).toBe("action");
  const actionFont = await title.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(actionFont).not.toMatch(/Iowan|Palatino|Georgia/);
  await page.screenshot({ path: "test-results/feature-pixels/interface-action.png" });

  // The account, not the browser, holds the choice: a reload stays Action.
  await page.reload();
  await waitSettled(page);
  expect(await resolvedMode(page)).toBe("action");
});
