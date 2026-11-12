import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * The Notes surface: one note written as a page, the way to every other note
 * in a "Notes" popover at the top (the chat's history chip), and linked notes
 * opening as panes beside the note being written, in the same page.
 *
 * The notes are seeded directly so the journey starts from a known list and
 * does not race bare /polymath/notes (which opens whatever note another spec
 * wrote last). Cleanup removes exactly what it created.
 */

function dbClient() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

async function seedNote(sql: postgres.Sql, title: string, kind: "note" | "zettel" = "note"): Promise<string> {
  const [user] = await sql`select id from users where clerk_user_id = 'dev-user' limit 1`;
  const [workspace] = await sql`
    select m.workspace_id from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = ${user.id} and m.status = 'active' and w.is_personal and w.archived_at is null
    limit 1`;
  const [note] = await sql`
    insert into artifacts (workspace_id, kind, title, status)
    values (${workspace.workspace_id}, ${kind}, ${title}, 'draft')
    returning id`;
  return note.id as string;
}

async function openNote(page: Page, id: string, title: string) {
  await page.goto(`/polymath/notes?id=${id}`);
  await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 30_000 });
}

test("the Notes popover lists notes by day, searches, and opens one", async ({ page }) => {
  test.setTimeout(120_000);
  const client = dbClient();
  if (!client) {
    test.skip(true, "DATABASE_URL not configured");
    return;
  }
  const tag = Date.now().toString(36);
  const older = `Harness notes ${tag}`;
  const current = `Protocol design ${tag}`;
  const zettel = `Atomic claim ${tag}`;
  const created: string[] = [];
  try {
    created.push(await seedNote(client, older));
    const currentId = await seedNote(client, current);
    created.push(currentId);
    created.push(await seedNote(client, zettel, "zettel"));

    await openNote(page, currentId, current);
    // No list column: the note has the page, and the list is one click away.
    await expect(page.locator("#notes-library")).toHaveCount(0);
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    const list = page.getByRole("navigation", { name: "Your notes" });
    await expect(list.getByText("Today")).toBeVisible();
    await expect(list.getByRole("link", { name: new RegExp(older) })).toBeVisible();
    await expect(list.getByRole("link", { name: new RegExp(current) })).toHaveAttribute("aria-current", "page");
    // Zettels live with ideas, not in the note list.
    await expect(list.getByRole("link", { name: new RegExp(zettel) })).toHaveCount(0);

    // Search narrows without closing the note being written.
    await page.getByRole("searchbox", { name: "Search notes" }).fill(`Harness notes ${tag}`);
    await expect(list.getByRole("link", { name: new RegExp(current) })).toHaveCount(0);
    await expect(page.getByLabel("Note title")).toHaveValue(current);

    await list.getByRole("link", { name: new RegExp(older) }).click();
    await expect(page.getByLabel("Note title")).toHaveValue(older);
    await expect(page.getByRole("navigation", { name: "Your notes" })).toHaveCount(0);
  } finally {
    if (created.length) await client`delete from artifacts where id in ${client(created)}`;
    await client.end();
  }
});

test("a [[link]] opens its note as a pane beside the note being written", async ({ page }) => {
  test.setTimeout(120_000);
  const client = dbClient();
  if (!client) {
    test.skip(true, "DATABASE_URL not configured");
    return;
  }
  const tag = Date.now().toString(36);
  const target = `Link target ${tag}`;
  const source = `Link source ${tag}`;
  const created: string[] = [];
  try {
    const targetId = await seedNote(client, target);
    created.push(targetId);
    const sourceId = await seedNote(client, source);
    created.push(sourceId);

    await openNote(page, sourceId, source);
    await page.locator(".ProseMirror").first().click();
    await page.keyboard.type(`See [[${target}]] and keep writing.`);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.locator(".ProseMirror .wiki-link", { hasText: target }).first().click();
    await expect(page).toHaveURL(new RegExp(`id=${sourceId}&stack=${targetId}`));
    const pane = page.getByRole("article", { name: target });
    await expect(pane).toBeVisible();
    // The written note stays where it was, still editable, beside the pane.
    await expect(page.getByLabel("Note title")).toHaveValue(source);
    await expect(page.getByLabel("Rich note content")).toContainText("keep writing");

    // The pane reads; "Write in" makes it the note being written.
    await pane.getByRole("link", { name: `Write in ${target}` }).click();
    await expect(page.getByLabel("Note title")).toHaveValue(target);
    await expect(page.getByRole("article")).toHaveCount(0);
  } finally {
    if (created.length) await client`delete from artifacts where id in ${client(created)}`;
    await client.end();
  }
});
