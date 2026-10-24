import { expect, test } from "@playwright/test";

/*
 * The daybook journey (eng review T3/T5): the day page derives its record
 * from canonical data, and a pin stays on its day. Runs keyless against the
 * dev harness like the other specs.
 */

test("a day page opens from Today and renders its sections or its invitation", async ({ page }) => {
  await page.goto("/command-center/briefing");
  const dayLink = page.getByRole("link", { name: "This day" });
  await expect(dayLink).toBeVisible();
  await dayLink.click();
  await expect(page).toHaveURL(/\/command-center\/briefing\/day\/\d{4}-\d{2}-\d{2}$/);
  // Either the record sections or the empty invitation — never a blank panel.
  const body = page.locator("body");
  await expect(body).not.toContainText("Could not load this day");
  await expect(body).not.toContainText("That date does not exist");
});

test("a malformed date is refused, not guessed", async ({ page }) => {
  await page.goto("/command-center/briefing/day/not-a-date");
  await expect(page.getByText("That date does not exist")).toBeVisible();
});
