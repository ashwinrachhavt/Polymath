import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * The invitation journey end to end (spec D4): the owner invites the second
 * provisioned dev user by link, that user's own session opens the link,
 * accepts, and then shows up in the owner's Members table. The second
 * session is selected per browser context by the polymath_dev_user cookie
 * (lib/auth.ts, dev fallback only); its stored email is what the keyless
 * harness's sessionVerifiedEmail stands in for the Clerk claim with, so the
 * invitation email is minted fresh per run and written onto the user row -
 * the journey is repeatable against a warm database with no cleanup.
 */
function db() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

async function secondUserSession(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ recordVideo: { dir: "test-results/feature-pixels" } });
  await context.addCookies([{ name: "polymath_dev_user", value: "dev-user-2", url: baseURL }]);
  const page = await context.newPage();
  return { context, page };
}

test("an invited second member accepts by link and appears in the members table", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const client = db();
  try {
    if (!client) test.skip(true, "DATABASE_URL not configured");
    // test.skip ends the test at runtime; the assertion narrows for the queries.
    const sql = client!;
    // Same default as playwright.config.ts; page.url() is still about:blank here.
    const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
    const tag = `member-${Date.now().toString(36)}@polymath.test`;

    // The second dev user answers to this run's invitation email.
    await sql`update users set email = ${tag} where clerk_user_id = 'dev-user-2'`;

    // The owner invites the tagged address and sees the one-time link.
    await page.goto("/settings/access");
    await expect(page.getByRole("heading", { level: 1, name: "Access" })).toBeVisible();
    await page.locator('input[name="email"]').fill(tag);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    // The URL paragraph only: the block also holds the Copy link button.
    const linkBlock = page.getByTestId("invite-link-url");
    await expect(linkBlock).toBeVisible();
    const inviteUrl = (await linkBlock.textContent())?.trim().match(/https?:\/\/\S+\/invitations\/\S+/)?.[0];
    expect(inviteUrl, "the one-time invite link is shown once").toBeTruthy();
    await page.screenshot({ path: "test-results/feature-pixels/invitation-created.png", fullPage: true });

    // The invited member's own session opens the link and accepts.
    const { context, page: joiner } = await secondUserSession(browser, baseURL);
    let acceptVideo = "";
    try {
      await joiner.goto(inviteUrl!);
      await expect(joiner.getByText("You were invited to")).toBeVisible();
      await expect(joiner.getByRole("button", { name: "Accept invitation" })).toBeVisible();
      await joiner.screenshot({ path: "test-results/feature-pixels/invitation-opened.png", fullPage: true });

      await joiner.getByRole("button", { name: "Accept invitation" }).click();
      await expect(joiner.getByTestId("accept-success")).toBeVisible();
      acceptVideo = (await joiner.video()?.path()) ?? "";
    } finally {
      await context.close(); // flushes the recorded video
    }
    if (acceptVideo) {
      const fs = await import("node:fs/promises");
      await fs.rename(acceptVideo, "test-results/feature-pixels/invitation-accept.webm").catch(() => undefined);
    }

    // The new member appears in the owner's console as a member.
    await page.reload();
    await expect(page.getByRole("cell", { name: tag })).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(row.getByText("member", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/feature-pixels/invitation-member-seated.png", fullPage: true });
  } finally {
    await client?.end();
  }
});
