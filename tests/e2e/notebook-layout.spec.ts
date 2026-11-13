import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { waitSettled } from "./helpers/settled";

/*
 * The notebook is a Space: the conversation is the centre and Studio is a
 * right rail, not a panel that drops under the conversation. The grid once lost
 * its third column (#567), so Studio, Runs and "In this notebook" fell to the
 * bottom of a single column; this measures where things actually sit at the
 * widths people use, so that cannot come back unseen. On a phone Studio is a
 * sheet opened from the header.
 *
 * It seeds one notebook with one ready source (the learn-loop spec's recipe)
 * and skips without DATABASE_URL.
 */

const TITLE = "Notebook layout e2e";
const SOURCE_TITLE = "Notebook layout e2e source";
const SOURCE_URL = "https://example.com/notebook-layout-e2e";

function db() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

async function clear(client: postgres.Sql) {
  await client`delete from notebooks where title = ${TITLE}`;
  await client`delete from sources where url = ${SOURCE_URL}`;
  await client`delete from documents where source_url = ${SOURCE_URL}`;
}

async function seed(): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    if (!owner) return null;
    await clear(client);
    const [notebook] = await client<{ id: string }[]>`
      insert into notebooks (workspace_id, title) values (${owner.workspace_id}, ${TITLE}) returning id`;
    const [source] = await client<{ id: string }[]>`
      insert into sources (workspace_id, kind, title, url)
      values (${owner.workspace_id}, 'url', ${SOURCE_TITLE}, ${SOURCE_URL}) returning id`;
    await client`
      insert into notebook_sources (workspace_id, notebook_id, source_id)
      values (${owner.workspace_id}, ${notebook.id}, ${source.id})`;
    const [doc] = await client<{ id: string }[]>`
      insert into documents (workspace_id, title, mime_type, source_url)
      values (${owner.workspace_id}, ${SOURCE_TITLE}, 'text/plain', ${SOURCE_URL}) returning id`;
    const [extraction] = await client<{ id: string }[]>`
      insert into document_extractions (workspace_id, document_id, content_hash, status, text, spans, extractor, embedded_at)
      values (${owner.workspace_id}, ${doc.id}, 'e2e-notebook-layout', 'succeeded', 'A notebook pins the source versions it was built from.', '[]'::jsonb, 'e2e@1', now())
      returning id`;
    await client`update documents set active_extraction_id = ${extraction.id} where id = ${doc.id}`;
    return notebook.id;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  const client = db();
  if (!client) return;
  try {
    await clear(client);
  } finally {
    await client.end();
  }
});

for (const width of [1280, 1440, 1920]) {
  test(`Studio is a right rail beside the conversation at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    const notebookId = await seed();
    test.skip(!notebookId, "DATABASE_URL not configured (server and test).");
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${notebookId}/notebook`);
    await waitSettled(page);

    const chat = page.getByRole("region", { name: "Chat" });
    const studio = page.getByRole("complementary", { name: "Studio" });
    await expect(chat).toBeVisible();
    await expect(studio).toBeVisible();
    // The four segments are all there, in the rail.
    for (const name of ["Create", "Learn", "Practice", "Library"]) {
      await expect(studio.getByRole("tab", { name })).toBeVisible();
    }

    const chatBox = (await chat.boundingBox())!;
    const studioBox = (await studio.boundingBox())!;
    // Beside, not below: the rail starts at or right of the conversation's right edge,
    // sits at the top of the same band, and stays inside the viewport.
    expect(studioBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 1);
    expect(studioBox.y).toBeLessThan(chatBox.y + Math.max(chatBox.height, 200));
    expect(studioBox.x + studioBox.width).toBeLessThanOrEqual(width);
    // The page itself does not scroll sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("on a phone Studio is a sheet opened from the header", async ({ page }) => {
  test.setTimeout(120_000);
  const notebookId = await seed();
  test.skip(!notebookId, "DATABASE_URL not configured (server and test).");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${notebookId}/notebook`);
  await waitSettled(page);

  await expect(page.getByRole("complementary", { name: "Studio" })).toBeHidden();
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Studio" });
  await expect(sheet.getByRole("tab", { name: "Learn" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
