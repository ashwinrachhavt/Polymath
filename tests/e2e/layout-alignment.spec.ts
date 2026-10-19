import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

// Exercise both header systems at narrow and wide widths. Geometry checks
// protect the shared gutters; visual inspection still owns design quality.
for (const width of [390, 1440]) {
  test(`shared page edges and controls align at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 960 });
    for (const path of ["/settings", "/reviews", "/command-center/relationships", "/alfred/knowledge", "/alfred/dossiers", "/more"]) {
      await page.goto(path);
      await waitSettled(page);
      const screen = page.locator(".suite-screen").first();
      const canonical = page.locator(".page-header").first();
      if (await screen.count()) {
        const header = await screen.locator(":scope > header").boundingBox();
        const content = await screen.locator(":scope > div").first().boundingBox();
        expect(header, path).not.toBeNull();
        expect(content, path).not.toBeNull();
        expect(Math.abs(header!.x - content!.x), path).toBeLessThan(1);
        expect(Math.abs(header!.width - content!.width), path).toBeLessThan(1);
      } else {
        const heading = await canonical.locator("h1").boundingBox();
        const content = await page.locator(".page-content").first().boundingBox();
        expect(heading, path).not.toBeNull();
        expect(content, path).not.toBeNull();
        expect(Math.abs(heading!.x - content!.x - (width < 768 ? 16 : 24)), path).toBeLessThan(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      const selects = page.locator('[data-slot="select-wrapper"]');
      for (const wrapper of await selects.all()) {
        const box = await wrapper.boundingBox();
        if (!box) continue;
        const select = await wrapper.locator("select").boundingBox();
        expect(select).not.toBeNull();
        expect(Math.abs(box.width - select!.width), path).toBeLessThan(1);
      }
    }
  });
}
