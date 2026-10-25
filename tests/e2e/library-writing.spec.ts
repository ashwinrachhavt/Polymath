import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for library writing (ASH-301): the Write-from-library composer on
 * the artifacts gallery, the drafted article the citation cites by title,
 * and the honest empty-library refusal. Runs against the free fixture
 * provider (GENERATION_PROVIDER=fixture): no model key, no spend.
 * Screenshots upload as the feature-pixels CI artifact.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const DOC_TITLE = "Polymath engineering notes";
const DOC_TEXT =
  "The review queue settles each proposal with the gate's verdict, and every settle " +
  "writes a receipt and an audit row in the same transaction. Agent surfaces call " +
  "searchDocumentsForAgent for library passages and cite each used passage by title.";
const TOPIC = "how proposals are settled";

function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

/** One library document whose current extraction carries searchable text. */
async function seedLibraryDocument(): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return false;
    const [doc] = await client<{ id: string }[]>`
      insert into documents (workspace_id, title, mime_type)
      values (${owner.workspace_id}, ${DOC_TITLE}, 'text/plain')
      returning id`;
    await client`
      insert into document_extractions (workspace_id, document_id, content_hash, status, text, spans, extractor)
      values (${owner.workspace_id}, ${doc.id}, 'e2e-library-writing', 'succeeded', ${DOC_TEXT}, '[]'::jsonb, 'e2e@1')`;
    return true;
  } finally {
    await client.end();
  }
}

async function removeSeeded(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client`delete from documents where title = ${DOC_TITLE}`;
    await client`delete from artifacts where title like ${`Library draft: ${TOPIC}%`}`;
  } finally {
    await client.end();
  }
}

test.afterAll(async () => {
  await removeSeeded();
});

for (const vp of VIEWPORTS) {
  test(`draft an article from the library [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    test.skip(!(await seedLibraryDocument()), "DATABASE_URL not configured");

    await page.goto("/artifacts");
    await page.getByRole("button", { name: "Write from library" }).click();
    await page.getByLabel("Draft topic").fill(TOPIC);
    await page.screenshot({ path: `test-results/feature-pixels/library-compose-${vp.name}.png`, style: HIDE_DEV_CHROME });

    await page.getByRole("button", { name: "Draft", exact: true }).click();
    await expect(page).toHaveURL(/\/artifacts\/[0-9a-f-]{36}/, { timeout: 60_000 });
    // The answer cites the used passage by title - the review citation.
    await expect(page.getByText(DOC_TITLE).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/library-draft-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });
  });

  test(`refuse honestly when the library has nothing [${vp.name}]`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const client = db();
    test.skip(!client, "DATABASE_URL not configured");

    await page.goto("/artifacts");
    await page.getByRole("button", { name: "Write from library" }).click();
    await page.getByLabel("Draft topic").fill("the price of unobtanium futures in 1932");
    await page.getByRole("button", { name: "Draft", exact: true }).click();
    // The refusal copy is the honest empty-library sentence, not a generated
    // article; Next's route announcer also has role=alert, so match by text.
    await expect(page.getByText(/The library has nothing on/)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `test-results/feature-pixels/library-empty-refusal-${vp.name}.png`, style: HIDE_DEV_CHROME });
  });
}
