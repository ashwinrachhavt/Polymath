import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env locally; CI exports DATABASE_URL.
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

/*
 * The Day Theatre on the briefing (ASH-308). Runs keyless against the dev
 * harness like the other specs; captures are seeded through the real API so
 * the strip reads the same rows the inbox does. The theatre never mutates
 * the inbox, so a scheduled chip stays a chip - the planned block on the
 * grid is the only signal, and it renders only when the slot lands inside
 * the day being shown.
 */

async function seedCapture(page: Page, title: string) {
  const response = await page.request.post("/api/v1/captures", {
    data: { text: `${title} body`, title },
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
}

test("the theatre renders the day grid, the now-line, and the strip", async ({ page }) => {
  await page.goto("/command-center/briefing");
  await expect(page.getByTestId("theatre-timeline")).toBeVisible();
  await expect(page.getByTestId("now-line")).toBeVisible();
  await expect(page.getByTestId("slot-0")).toBeVisible();
  // The strip is always present: chips when the inbox received today, the
  // empty invitation otherwise - never a blank region.
  const strip = page.getByTestId("capture-strip");
  if ((await strip.count()) === 0) {
    await expect(page.getByText("Nothing captured yet today.")).toBeVisible();
  }
  // The decisions strip survives below the theatre.
  await expect(page.getByText("Three outcomes")).toBeVisible();
});

test("a past hour refuses the drop - no block, no request, the chip stays", async ({ page }) => {
  const tag = `Refuse ${Date.now().toString(36)}`;
  await page.goto("/command-center/briefing");
  await seedCapture(page, tag);
  await page.reload();
  const chip = page.getByTestId("capture-strip").getByText(tag, { exact: false });
  await expect(chip).toBeVisible();

  await page.evaluate((title) => {
    const chipEl = [...document.querySelectorAll("[data-testid^='capture-chip-']")].find((el) => el.textContent?.includes(title));
    const slotEl = document.querySelector("[data-testid='slot-0']");
    if (!chipEl || !slotEl) throw new Error("chip or slot missing");
    const data = new DataTransfer();
    chipEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    slotEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: data }));
    slotEl.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  }, tag);

  // Hour 0 began before this test ran, so the drop is refused: no planned
  // block anywhere on the grid, and the chip is still offered.
  await page.waitForTimeout(1_200); // past the visual-refusal window
  await expect(page.locator("[data-testid^='planned-session-']", { hasText: tag })).toHaveCount(0);
  await expect(page.getByTestId("capture-strip").getByText(tag, { exact: false })).toBeVisible();
});

test("a drop on a future hour plans the capture", async ({ page }) => {
  // Two hours ahead must still be today for the block to render on this
  // grid; from 22:00 local on, no future slot remains and the tap-fallback
  // spec owns the positive scheduling path.
  const hour = await page.evaluate(() => new Date().getHours());
  test.skip(hour >= 22, "no future slot remains on today's grid");

  const tag = `Drop ${Date.now().toString(36)}`;
  await page.goto("/command-center/briefing");
  await seedCapture(page, tag);
  await page.reload();
  const chip = page.getByTestId("capture-strip").getByText(tag, { exact: false });
  await expect(chip).toBeVisible();

  await page.evaluate(
    ([title, targetHour]) => {
      const chipEl = [...document.querySelectorAll("[data-testid^='capture-chip-']")].find((el) => el.textContent?.includes(title));
      const slotEl = document.querySelector(`[data-testid='slot-${targetHour}']`);
      if (!chipEl || !slotEl) throw new Error("chip or slot missing");
      const data = new DataTransfer();
      chipEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
      slotEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: data }));
      slotEl.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
    },
    [tag, hour + 2] as const,
  );

  await expect(page.locator("[data-testid^='planned-session-']", { hasText: tag })).toBeVisible({ timeout: 15_000 });
});

test("a session finished behind the page's back shows finished within one poll", async ({ page }) => {
  const sql = db();
  if (!sql) {
    test.skip(true, "DATABASE_URL required to change a session mid-journey");
    return;
  }
  const tag = `Live ${Date.now().toString(36)}`;
  try {
    await page.goto("/command-center/briefing");
    await seedCapture(page, `${tag} anchor`);
    const [capture] = await sql<{ workspace_id: string; created_by: string }[]>`
      select workspace_id, created_by from captures where text = ${`${tag} anchor body`} limit 1`;
    // The live slot is unique per workspace: clear any leftover live session
    // from an earlier harness run before taking it.
    await sql`update focus_sessions set state = 'finished', ended_at = now()
      where workspace_id = ${capture.workspace_id} and state in ('running', 'paused') and started_at is not null`;
    await sql`insert into focus_sessions (workspace_id, subject, state, started_at, created_by, updated_by)
      values (${capture.workspace_id}, ${tag}, 'running', now(), ${capture.created_by}, ${capture.created_by})`;

    await page.reload();
    const block = page.locator("[data-testid^='session-']", { hasText: tag });
    await expect(block).toBeVisible();
    await expect(block).toContainText("in progress");

    await sql`update focus_sessions set state = 'finished', ended_at = now() where subject = ${tag}`;
    // The theatre polls every 30 s while visible; allow a full interval plus
    // the server round-trip before calling the marker stale.
    await expect(block).toContainText("finished", { timeout: 45_000 });
  } finally {
    await sql`update focus_sessions set state = 'finished', ended_at = now() where subject = ${tag}`.catch(() => undefined);
    await sql.end();
  }
});

test("tap fallback plans the capture from a touch viewport", async ({ page }) => {
  // The picker's first slot is the next whole hour; before 23:00 local that
  // lands inside today's grid. In the 23:xx hour the slot rolls to tomorrow
  // and the block renders on tomorrow's theatre instead, so the visual
  // assertion would test nothing - skip it there, documented and rare.
  const hour = await page.evaluate(() => new Date().getHours());
  test.skip(hour >= 23, "the next whole hour falls on tomorrow's grid");

  const tag = `Plan ${Date.now().toString(36)}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/command-center/briefing");
  await seedCapture(page, tag);
  await page.reload();

  const chip = page.getByTestId("capture-strip").getByText(tag, { exact: false });
  await expect(chip).toBeVisible();
  await chip.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem").first().click();

  await expect(page.locator("[data-testid^='planned-session-']", { hasText: tag })).toBeVisible({ timeout: 15_000 });
});
