import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { waitSettled } from "./helpers/settled";

/*
 * The workspace switcher journey (tenancy activation, spec D2): the top bar
 * names the workspace you are in, lists every workspace the session belongs
 * to, and switching changes the data context every surface reads — proved
 * here on the notes list, with the switcher driven by mouse and by keyboard,
 * an axe scan over the open popover, and a pageerror net across the whole
 * journey. The second workspace is seeded directly (the create-workspace
 * flow is T4's), and the pending-invitation row is seeded as an open
 * invitation row addressed to the dev owner's stored email — the keyless
 * stand-in for the session's Clerk email, same as the invitation journey.
 *
 * The switcher lives in the top bar, and /polymath/* surfaces render
 * headerless by design, so switching happens on a top-bar surface (/more)
 * and the notes list is the observed surface.
 */

function dbClient() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

async function seedJourney(sql: postgres.Sql, tag: string) {
  const [user] = await sql`select id, email from users where clerk_user_id = 'dev-user' limit 1`;
  const [personal] = await sql`
    select m.workspace_id from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = ${user.id} and m.status = 'active' and w.is_personal and w.archived_at is null
    limit 1`;
  const [target] = await sql`
    insert into workspaces (name, slug, is_personal) values (${`Acme ${tag}`}, ${`switch-target-${tag}`}, false)
    returning id`;
  await sql`insert into memberships (workspace_id, user_id, role, status) values (${target.id}, ${user.id}, 'owner', 'active')`;
  // A workspace the user is invited to but has not joined: the switcher's
  // pending-invitation row, via the session email the keyless harness uses.
  const [invited] = await sql`
    insert into workspaces (name, slug, is_personal) values (${`Invited ${tag}`}, ${`switch-invited-${tag}`}, false)
    returning id`;
  await sql`
    insert into invitations (workspace_id, email, role, token_hash, expires_at, created_by, updated_by)
    values (${invited.id}, ${`switcher-${tag}@polymath.test`}, 'admin', ${`hash-${crypto.randomUUID()}`},
            now() + interval '7 days', ${user.id}, ${user.id})`;
  // One note per workspace: the data-context change the notes surface must show.
  const [homeNote] = await sql`
    insert into artifacts (workspace_id, kind, title, status)
    values (${personal.workspace_id}, 'note', ${`Home note ${tag}`}, 'draft')
    returning id`;
  const [targetNote] = await sql`
    insert into artifacts (workspace_id, kind, title, status)
    values (${target.id}, 'note', ${`Target note ${tag}`}, 'draft')
    returning id`;
  return {
    userId: user.id,
    priorEmail: user.email as string | null,
    targetId: target.id as string,
    invitedId: invited.id as string,
    homeNoteId: homeNote.id as string,
    targetNoteId: targetNote.id as string,
  };
}

/*
 * Opens a note by id. Bare /polymath/notes opens the workspace's latest note,
 * and other specs in the same shard write newer notes to the same database, so
 * the journey addresses its seeded notes directly instead of relying on order.
 */
async function openNote(page: Page, id: string) {
  await page.goto(`/polymath/notes?id=${id}`);
  await waitSettled(page);
}

/* Another workspace's note reads as absent, not as the note. */
async function expectNoteHidden(page: Page, id: string) {
  await openNote(page, id);
  await expect(page.getByRole("heading", { name: "That note is not here" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Note title")).toHaveCount(0);
}

async function openSwitcher(page: Page) {
  const trigger = page.getByRole("button", { name: /switch workspace/i });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Workspaces" });
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

test("switching workspaces changes the data context on the notes list", async ({ page }) => {
  test.setTimeout(240_000);
  const client = dbClient();
  if (!client) {
    test.skip(true, "DATABASE_URL not configured");
    return;
  }
  const sql = client;
  try {
    const tag = `sw-${Date.now().toString(36)}`;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const seed = await seedJourney(sql, tag);
    // The invitation row is addressed to the session email; in the keyless
    // harness that is the user row's stored address. Restored in cleanup.
    const journeyEmail = `switcher-${tag}@polymath.test`;
    await sql`update users set email = ${journeyEmail} where id = ${seed.userId}`;

    try {
      // The switcher's membership rows are cached per user (use cache, tag
      // invalidated only by the app's own mutation actions), and this journey
      // seeds rows with raw SQL. A shell render earlier in the same dev
      // server would otherwise serve the stale list. Creating a workspace
      // through the real form expires the tag; dropping the cookie it sets
      // returns the device to the personal workspace. The throwaway workspace is
      // left in place, as workspace-create.spec.ts does: its audit event pins it.
      await page.goto("/workspaces/create");
      await page.locator('input[name="name"]').fill(`Cache bust ${tag}`);
      await page.getByRole("button", { name: "Create workspace" }).click();
      await expect(page).toHaveURL(/\/onboarding$/, { timeout: 30_000 });
      await page.context().clearCookies({ name: "polymath_active_workspace" });

      await page.goto("/more");
      await waitSettled(page);

      // The switcher opens, names every workspace with its role, and marks
      // the current one; the pending invitation names its workspace.
      const { trigger, dialog } = await openSwitcher(page);
      await expect(trigger).toHaveAttribute("aria-label", /currently Personal/, { timeout: 15_000 });
      const targetRow = dialog.getByRole("button", { name: new RegExp(`Acme ${tag}`) });
      const personalRow = dialog.getByRole("button", { name: /Personal/ });
      await expect(personalRow).toHaveAttribute("aria-current", "true");
      await expect(targetRow.getByText("owner", { exact: true })).toBeVisible();
      await expect(dialog.getByText(`Invited to Invited ${tag}`)).toBeVisible();

      // The open popover is the new UI surface, so the axe scan runs with it
      // up: keyboard-operable rows, labeled dialog, no contrast surprises.
      await waitSettled(page);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(violations, "popover open").toEqual([]);

      // Escape closes and returns focus to the trigger — no pointer-only path.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      // Switch to Acme: the popover closes, the trigger renames, and the
      // per-device cookie now names the target workspace.
      await trigger.click();
      await expect(dialog).toBeVisible();
      await targetRow.click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-label", new RegExp(`currently Acme ${tag}`), { timeout: 30_000 });
      const cookie = (await page.context().cookies()).find((c) => c.name === "polymath_active_workspace");
      expect(cookie?.value, "the active-workspace cookie names the target").toBe(seed.targetId);

      // The data context changed: Acme's note opens, and the personal note is
      // out of reach from here.
      await openNote(page, seed.targetNoteId);
      await expect(page.getByLabel("Note title")).toHaveValue(`Target note ${tag}`, { timeout: 30_000 });
      await page.screenshot({ path: "test-results/feature-pixels/switcher-notes-acme.png", fullPage: true });
      await expectNoteHidden(page, seed.homeNoteId);

      // Keyboard leg: focus the trigger, Enter opens, the first Tab stop is a
      // workspace row, Enter on the Personal row switches back. In dev the
      // streamed shell can replace the top bar between focus and keypress and
      // swallow the first Enter, so press focuses with auto-wait and one
      // bounded retry stands in for that lost key — the second Enter failing
      // would still fail the journey, as a real keyboard bug must.
      await page.goto("/more");
      await waitSettled(page);
      const trigger2 = page.getByRole("button", { name: /switch workspace/i });
      await trigger2.press("Enter");
      const dialog2 = page.getByRole("dialog", { name: "Workspaces" });
      try {
        await expect(dialog2).toBeVisible({ timeout: 3000 });
      } catch {
        const focusNow = await page.evaluate(
          () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "none",
        );
        await trigger2.press("Enter");
        await expect(dialog2, `first Enter landed on ${focusNow}`).toBeVisible();
      }
      await page.keyboard.press("Tab");
      // Tab enters the list: focus moves to a focusable inside the popover
      // content rather than being lost in the page around it.
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null))
        .toBe(true);
      // A focused row activates with Enter — the keyboard switch back to the
      // personal workspace.
      await dialog2.getByRole("button", { name: /Personal/ }).press("Enter");
      await expect(dialog2).toBeHidden();

      // Back in the personal workspace, the home note is the context again and
      // Acme's note is out of reach.
      await openNote(page, seed.homeNoteId);
      await expect(page.getByLabel("Note title")).toHaveValue(`Home note ${tag}`, { timeout: 30_000 });
      await page.screenshot({ path: "test-results/feature-pixels/switcher-notes-personal.png", fullPage: true });
      await expectNoteHidden(page, seed.targetNoteId);

      expect(errors).toEqual([]);
    } finally {
      // Deleting the workspaces cascades to their memberships, invitations
      // and artifacts; the home note and the session email are restored
      // explicitly so the shared dev owner is exactly as the journey found it.
      await sql`delete from workspaces where id in (${seed.targetId}, ${seed.invitedId})`;
      await sql`delete from artifacts where id = ${seed.homeNoteId}`;
      if (seed.priorEmail === null) await sql`update users set email = null where id = ${seed.userId}`;
      else await sql`update users set email = ${seed.priorEmail} where id = ${seed.userId}`;
    }
  } finally {
    await client.end();
  }
});
