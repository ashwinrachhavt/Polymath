import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { waitSettled } from "./helpers/settled";

/*
 * The shell's focus dock follows the REAL live session across canonical
 * pages: start on Work, see it elsewhere, return, finish, gone. A failed
 * read keeps the last known session with an explicit stale cue rather than
 * claiming the session ended or showing it as verified. Pixels at desktop
 * and mobile widths, including the stale cue's mobile fit, are captured for
 * review (test-results/feature-pixels/focus-dock-*.png).
 */
function db() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

test("the dock follows a real session across pages, marks a failed read stale, and leaves when it finishes", async ({ page }) => {
  test.setTimeout(180_000);
  const client = db();
  const tag = `dock-${Date.now().toString(36)}`;
  try {
    // Start a real session from the task's Focus action on Work.
    await page.goto("/neuralflow/work?view=saved");
    await waitSettled(page);
    await page.getByLabel("New task title").fill(tag);
    await page.getByRole("button", { name: "Add task" }).click();
    await page.getByRole("searchbox", { name: "Search tasks" }).fill(tag);
    await page.getByRole("link", { name: tag, exact: true }).click();
    await expect(page).toHaveURL(/task=[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "Start focus", exact: true }).click();
    await expect(page.getByText("A focus session is running.", { exact: true })).toBeVisible();
    // On Work itself the dock stays out of the way - the controls are on the page.
    await expect(page.getByLabel("Focus session")).toBeHidden();

    // Navigate away: the dock names the live session and links back.
    await page.goto("/command-center/briefing");
    const dock = page.getByLabel("Focus session");
    await expect(dock).toBeVisible();
    await expect(dock).toContainText("Focus running");
    await expect(dock).toContainText(tag);
    await page.screenshot({ path: "test-results/feature-pixels/focus-dock-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dock).toBeVisible();
    // In-viewport proof: the dock sits above the Destinations bar, fully
    // inside the 390x844 viewport - a sticky footer the bar covers is no
    // indicator at all.
    const dockBox = await dock.boundingBox();
    const navBox = await page.getByRole("navigation", { name: "Destinations", exact: true }).boundingBox();
    expect(dockBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(dockBox!.y).toBeGreaterThanOrEqual(0);
    expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
    await page.screenshot({ path: "test-results/feature-pixels/focus-dock-mobile.png" });

    // A failed read keeps the last known session, marked stale - it never
    // claims the session ended, and never presents it as verified. The stale
    // state lives in the mounted component, so the failed read must happen
    // through the dock's own refetch (window focus), not a page reload that
    // remounts it with nothing.
    await page.route("**/api/v1/focus/live", (route) => route.abort());
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dock).toContainText("last known");
    await expect(dock).toContainText("status may be out of date");
    await page.screenshot({ path: "test-results/feature-pixels/focus-dock-mobile-stale.png" });
    await page.setViewportSize({ width: 1280, height: 800 });

    // A successful read clears the stale mark.
    await page.unroute("**/api/v1/focus/live");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dock).toContainText("Focus running");
    await expect(dock).not.toContainText("last known");

    // Return to the session, finish it, and the dock is gone everywhere.
    await dock.getByRole("link").click();
    await expect(page).toHaveURL(/\/neuralflow\/work\?view=today/);
    await expect(page.getByText("A focus session is running.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(page.getByText("A focus session is running.", { exact: true })).toBeHidden();
    await page.goto("/command-center/briefing");
    await expect(page.getByLabel("Focus session")).toBeHidden();
  } finally {
    if (client) {
      await client`delete from focus_sessions where subject = ${tag}`;
      await client`delete from tasks where title = ${tag}`;
      await client.end();
    }
  }
});
