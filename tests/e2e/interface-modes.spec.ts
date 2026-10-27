import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * ASH-312: Library and Action are two interface languages behind one
 * account preference. The journey pins Library in Settings, watches the
 * decision queue re-render in the calm register, flips to Action from the
 * header toggle, and reloads to prove the choice lives on the account, not
 * in the browser - then replays the journey at a phone viewport, where the
 * same header toggle is the control. One sequential journey: the preference
 * is a single account row (CAS-versioned), so two parallel viewports would
 * race the same record.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";

async function resolvedMode(page: import("@playwright/test").Page): Promise<string> {
  return page.locator("[data-interface-mode]").first().getAttribute("data-interface-mode") as Promise<string>;
}

test("interface mode is an account preference with two visual languages", async ({ page }) => {
  test.setTimeout(180_000);

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/settings");
    await waitSettled(page, { capture: false });
    await expect(page.getByRole("heading", { name: "Settings", exact: true }).first()).toBeVisible();

    // Skip cleanly where settings is only a browser preview (no sign-in).
    const modeSelect = page.locator('select[name="interfaceMode"]');
    test.skip(!(await modeSelect.count()), "server-saved preferences unavailable on this deployment");

    // Pin Library from Settings; the whole workspace re-renders in it.
    await modeSelect.selectOption("library");
    await page.getByRole("button", { name: "Save interface mode" }).click();
    await expect(page.getByText(/Interface mode saved/)).toBeVisible();
    // Confirm at the source of truth: notifications live in an app-level
    // stack, so a toast from the previous viewport pass can satisfy the text
    // check while the save itself lost a CAS race on the shared account
    // preference row. Re-render Settings and re-save until the row reads
    // Library back from the server.
    await expect(async () => {
      await page.goto("/settings");
      const select = page.locator('select[name="interfaceMode"]');
      if ((await select.inputValue()) !== "library") {
        await select.selectOption("library");
        await page.getByRole("button", { name: "Save interface mode" }).click();
        await expect(page.getByRole("button", { name: "Save interface mode" })).toBeEnabled({ timeout: 15_000 });
        await page.goto("/settings");
      }
      await expect(page.locator('select[name="interfaceMode"]')).toHaveValue("library");
    }).toPass({ timeout: 30_000 });

    // "/" redirects to the conversation now, and the conversation has no page
    // heading, so the library register is read on a destination that does.
    await page.goto("/neuralflow/work");
    await waitSettled(page);
    expect(await resolvedMode(page)).toBe("library");
    const title = page.locator("#content h1");
    await expect(title).toHaveText("Work");
    const libraryFont = await title.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(libraryFont).toMatch(/Iowan|Palatino|Georgia/);

    await page.addStyleTag({ content: HIDE_DEV_CHROME });
    await page.screenshot({ path: `test-results/feature-pixels/interface-library-${vp.name}.png` });

    // One tap in the header pins Action; the register tightens.
    await page.getByRole("button", { name: "Switch to Action mode" }).click();
    await expect.poll(() => resolvedMode(page)).toBe("action");
    const actionFont = await title.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(actionFont).not.toMatch(/Iowan|Palatino|Georgia/);
    await page.screenshot({ path: `test-results/feature-pixels/interface-action-${vp.name}.png` });

    // The account, not the browser, holds the choice: a reload stays Action.
    await page.reload();
    await waitSettled(page);
    expect(await resolvedMode(page)).toBe("action");
  }
});
