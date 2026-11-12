import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * The Notes library journey: the rail is a browsable home for every note, not
 * just the one being edited. It lists the workspace's notes with the open one
 * marked, moves between them without losing the workspace shell, narrows by
 * search, steps aside while the note is written, and remembers being put away.
 *
 * The notes are seeded directly so the journey starts from a known list and
 * does not race bare /polymath/notes (which opens whatever note another spec
 * wrote last). Cleanup removes exactly what it created.
 */

function dbClient() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

async function seedNote(sql: postgres.Sql, title: string): Promise<string> {
  const [user] = await sql`select id from users where clerk_user_id = 'dev-user' limit 1`;
  const [workspace] = await sql`
    select m.workspace_id from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = ${user.id} and m.status = 'active' and w.is_personal and w.archived_at is null
    limit 1`;
  const [note] = await sql`
    insert into artifacts (workspace_id, kind, title, status)
    values (${workspace.workspace_id}, 'note', ${title}, 'draft')
    returning id`;
  return note.id as string;
}

async function openNote(page: Page, id: string, title: string) {
  await page.goto(`/polymath/notes?id=${id}`);
  await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 30_000 });
}

test("opens another note from the rail, and finds one by search", async ({ page }) => {
  test.setTimeout(120_000);
  const client = dbClient();
  if (!client) {
    test.skip(true, "DATABASE_URL not configured");
    return;
  }
  const tag = Date.now().toString(36);
  const older = `Harness notes ${tag}`;
  const current = `Protocol design ${tag}`;
  const created: string[] = [];
  try {
    const olderId = await seedNote(client, older);
    created.push(olderId);
    const currentId = await seedNote(client, current);
    created.push(currentId);

    await openNote(page, currentId, current);
    const rail = page.locator("#notes-library");

    // Both notes are in the library, and the open one says so.
    await expect(rail.getByRole("link", { name: new RegExp(older) })).toBeVisible();
    await expect(rail.getByRole("link", { name: new RegExp(current) })).toHaveAttribute("aria-current", "page");

    // Following a rail link is navigation, not a reload: the other note opens.
    await rail.getByRole("link", { name: new RegExp(older) }).click();
    await expect(page).toHaveURL(new RegExp(`id=${olderId}`));
    await expect(page.getByLabel("Note title")).toHaveValue(older);
    await expect(rail.getByRole("link", { name: new RegExp(older) })).toHaveAttribute("aria-current", "page");

    // Search narrows the rail without closing the note being read.
    await rail.getByRole("searchbox", { name: "Search notes" }).fill("Protocol design");
    await expect(rail.getByRole("link", { name: new RegExp(current) })).toBeVisible();
    await expect(rail.getByRole("link", { name: new RegExp(older) })).toHaveCount(0);
    await expect(page.getByLabel("Note title")).toHaveValue(older);

    await rail.getByRole("link", { name: new RegExp(current) }).click();
    await expect(page).toHaveURL(new RegExp(`id=${currentId}`));
    await expect(page.getByLabel("Note title")).toHaveValue(current);
  } finally {
    if (created.length) await client`delete from artifacts where id in ${client(created)}`;
    await client.end();
  }
});

test("the rail steps aside while writing and remembers being put away", async ({ page }) => {
  test.setTimeout(120_000);
  const client = dbClient();
  if (!client) {
    test.skip(true, "DATABASE_URL not configured");
    return;
  }
  const title = `Quiet writing ${Date.now().toString(36)}`;
  let noteId: string | null = null;
  try {
    noteId = await seedNote(client, title);
    await openNote(page, noteId, title);

    const rail = page.locator("#notes-library");
    await expect(rail).toHaveAttribute("data-state", "open");

    // Writing the note is the one state the rail must not compete with.
    // (No leading space: the editor reads a space after some keys as its AI trigger.)
    await page.locator(".ProseMirror").first().click();
    await page.keyboard.type("first thought");
    await expect(page.getByLabel("Rich note content")).toContainText("first thought");
    await expect(rail).toHaveAttribute("data-state", "writing");
    // Idle brings it back on its own; nobody has to click.
    await expect(rail).toHaveAttribute("data-state", "open", { timeout: 5_000 });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // Put away deliberately: the note column takes the room, and the choice
    // survives a reload because it is this browser's preference.
    await page.getByRole("button", { name: "Hide the note list" }).click();
    await expect(rail).toHaveAttribute("data-state", "collapsed");
    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title);
    await expect(page.locator("#notes-library")).toHaveAttribute("data-state", "collapsed");
    await page.getByRole("button", { name: "Show the note list" }).first().click();
    await expect(page.locator("#notes-library")).toHaveAttribute("data-state", "open");
  } finally {
    if (noteId) await client`delete from artifacts where id = ${noteId}`;
    await client.end();
  }
});
