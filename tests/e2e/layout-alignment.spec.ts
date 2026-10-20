import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

// Exercise both header systems at narrow and wide widths. Geometry checks
// protect the shared gutters; visual inspection still owns design quality.
for (const width of [390, 1440, 1920]) {
  test(`shared page edges and controls align at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 960 });
    for (const path of ["/settings", "/reviews", "/command-center/relationships", "/alfred/knowledge", "/alfred/dossiers", "/more"]) {
      await page.goto(path);
      await waitSettled(page);
      // Scope to the shell's content main: route-level loading.tsx renders a
      // second skeleton main, and streamed pages swap it in late.
      const screen = page.locator("#content .suite-screen").first();
      const canonical = page.locator("#content .page-header").first();
      if (await screen.count()) {
        const headerEl = screen.locator(":scope > header");
        const contentEl = screen.locator(":scope > div").first();
        await expect(headerEl, path).toBeVisible();
        await expect(contentEl, path).toBeVisible();
        const header = await headerEl.boundingBox();
        const content = await contentEl.boundingBox();
        expect(header, path).not.toBeNull();
        expect(content, path).not.toBeNull();
        expect(Math.abs(header!.x - content!.x), path).toBeLessThan(1);
        expect(Math.abs(header!.width - content!.width), path).toBeLessThan(1);
      } else {
        const headingEl = canonical.locator("h1");
        const contentEl = page.locator("#content .page-content").first();
        await expect(headingEl, path).toBeVisible();
        await expect(contentEl, path).toBeVisible();
        const heading = await headingEl.boundingBox();
        const content = await contentEl.boundingBox();
        expect(heading, path).not.toBeNull();
        expect(content, path).not.toBeNull();
        expect(Math.abs(heading!.x - content!.x - (width < 768 ? 16 : 24)), path).toBeLessThan(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      const selects = page.locator('[data-slot="select-wrapper"]');
      for (const wrapper of await selects.all()) {
        const box = await wrapper.boundingBox();
        if (!box) continue;
        // Streaming/hydration can leave a select at zero width for a frame
        // after the first paint; retry the measurement until the box settles.
        await expect(async () => {
          const select = await wrapper.locator("select").boundingBox();
          expect(select).not.toBeNull();
          expect(select!.width, path).toBeGreaterThan(0);
          expect(Math.abs(box.width - select!.width), path).toBeLessThan(1);
        }).toPass();
      }
    }
  });
}
