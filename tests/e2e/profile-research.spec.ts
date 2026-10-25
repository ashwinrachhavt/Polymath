import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * Pixels for profile research (ASH-291): the Research workflow embedded on
 * the company profile and the person profile - click, grounded card set with
 * citations and sources, focused re-research - against the free fixture
 * environment (GENERATION_PROVIDER=fixture fixes generation, search and page
 * fetches). No network, no model key, no spend. Screenshots upload as the
 * feature-pixels CI artifact.
 */

/**
 * Resolves when this click's server action returns. Proof the triggered run
 * completed - never satisfied by the previous attempt's rendered card set.
 */
function waitForAction(page: Page) {
  return page.waitForResponse(
    (res) => res.request().method() === "POST" && res.request().headers()["next-action"] !== undefined && res.ok(),
    { timeout: 60_000 },
  );
}

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

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

const COMPANY_NAME = "Example";
const COMPANY_DOMAIN = "example.com";
const CONTACT_NAME = "Priya Nair";
const CONTACT_EMAIL = "priya.nair+profile-research@example.com";

type Seeded = { companyId: string; contactId: string };

/** The CRM company (with a domain to crawl) and its current contact. */
async function seedResearchSubjects(): Promise<Seeded | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    const ws = owner.workspace_id;
    const uid = owner.user_id;

    // The viewport tests run fully parallel against one shared database, so
    // serialize the seed itself; without the lock two tests can both find the
    // company missing and race the unique (workspace_id, domain) index.
    await client`select pg_advisory_lock(920291)`;
    try {
      const [existing] = await client<{ id: string }[]>`
        select id from companies where workspace_id = ${ws} and domain = ${COMPANY_DOMAIN} and archived_at is null limit 1`;
      const companyId =
        existing?.id ??
        (
          await client<{ id: string }[]>`
          insert into companies (workspace_id, name, domain, description, created_by, updated_by)
          values (${ws}, ${COMPANY_NAME}, ${COMPANY_DOMAIN}, 'Spending analytics for small teams', ${uid}, ${uid})
          on conflict do nothing
          returning id`
        )[0]?.id ??
        (
          await client<{ id: string }[]>`
          select id from companies where workspace_id = ${ws} and domain = ${COMPANY_DOMAIN} limit 1`
        )[0].id;

      const [existingContact] = await client<{ id: string }[]>`
        select id from contacts where workspace_id = ${ws} and primary_email = ${CONTACT_EMAIL} and archived_at is null limit 1`;
      const contactId =
        existingContact?.id ??
        (
          await client<{ id: string }[]>`
          insert into contacts (workspace_id, full_name, primary_email, title, created_by, updated_by)
          values (${ws}, ${CONTACT_NAME}, ${CONTACT_EMAIL}, 'Platform lead', ${uid}, ${uid})
          on conflict do nothing
          returning id`
        )[0]?.id ??
        (
          await client<{ id: string }[]>`
          select id from contacts where workspace_id = ${ws} and primary_email = ${CONTACT_EMAIL} limit 1`
        )[0].id;

      const [existingLink] = await client<{ id: string }[]>`
        select id from contact_companies where contact_id = ${contactId} and company_id = ${companyId} limit 1`;
      if (!existingLink) {
        await client`
          insert into contact_companies (workspace_id, contact_id, company_id, title, is_current)
          values (${ws}, ${contactId}, ${companyId}, 'Platform lead', true)
          on conflict do nothing`;
      }
      return { companyId, contactId };
    } finally {
      await client`select pg_advisory_unlock(920291)`;
    }
  } finally {
    await client.end();
  }
}

for (const vp of VIEWPORTS) {
  test(`research a company from its profile [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const seeded = await seedResearchSubjects();
    test.skip(!seeded, "DATABASE_URL not configured");

    await page.goto(`/command-center/relationships/companies/${seeded!.companyId}`);
    await expect(page.getByRole("heading", { name: COMPANY_NAME }).first()).toBeVisible({ timeout: 30_000 });
    // Retries and local reruns land on the already-researched profile; the
    // fresh state is asserted and captured only when it is actually there.
    const trigger = page.getByRole("button", { name: /Research (company|again)/ });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    if (await page.getByText("Not researched yet").isVisible()) {
      await page.screenshot({ path: `test-results/feature-pixels/company-profile-fresh-${vp.name}.png`, style: HIDE_DEV_CHROME });
    }

    const actionDone = waitForAction(page);
    await trigger.click();
    await actionDone;
    // The controls' completion line renders only from this run's resolved
    // action (client state, never server-rendered), then the revalidated
    // card set is asserted.
    await expect(page.getByText(/\d+ cards? from \d+ sources?\./)).toBeVisible();
    const result = page.getByTestId("profile-research-result");
    await expect(result).toBeVisible();
    // Exact text: the source links quote these titles and would otherwise
    // trip strict mode.
    await expect(result.getByText("Spending analytics for small teams", { exact: true })).toBeVisible();
    await expect(result.getByText("Seed round to expand analytics", { exact: true })).toBeVisible();
    // Citations resolve into the disclosed source list.
    await result.getByText("Sources (4)", { exact: true }).click();
    await expect(result.getByRole("link", { name: "About Example" })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/company-profile-researched-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

    if (vp.name === "mobile") {
      // Real-viewport proof, not fullPage stitching: scroll the Offerings
      // card and the open Sources list into view with keyboard focus moved
      // off the skip-link, then capture what a phone actually shows - this
      // distinguishes screenshot stitching from real sticky obstruction.
      const sourcesToggle = result.getByText("Sources (4)", { exact: true });
      await sourcesToggle.focus();
      await result.getByText("Offerings", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/feature-pixels/company-profile-offerings-viewport-mobile.png", style: HIDE_DEV_CHROME });
      await sourcesToggle.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/feature-pixels/company-profile-sources-viewport-mobile.png", style: HIDE_DEV_CHROME });
    }

    // The linked contact renders on the profile, and the record panel fits.
    await expect(page.getByRole("link", { name: CONTACT_NAME, exact: true })).toBeVisible();
  });

  test(`research a person from their profile, then refocus [${vp.name}]`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const seeded = await seedResearchSubjects();
    test.skip(!seeded, "DATABASE_URL not configured");

    await page.goto(`/command-center/relationships/contacts?id=${seeded!.contactId}`);
    // After a prior attempt the trigger reads "Research again".
    const trigger = page.getByRole("button", { name: /Research (person|again)/ });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    const actionDone = waitForAction(page);
    await trigger.click();
    await actionDone;
    await expect(page.getByText(/\d+ cards? from \d+ sources?\./)).toBeVisible();
    const result = page.getByTestId("profile-research-result");
    await expect(result).toBeVisible();
    await expect(result.getByText("Platform lead at Example", { exact: true })).toBeVisible();
    await expect(result.getByText("Ask about the pricing launch", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/person-profile-researched-${vp.name}.png`, style: HIDE_DEV_CHROME, fullPage: true });

    // A focus button re-researches one angle; the card set refreshes in place.
    const focusDone = waitForAction(page);
    await page.getByRole("button", { name: "Talking points" }).click();
    await focusDone;
    // The focused pass replaces the rendered set on revalidation: wait for
    // its own header and the honest gap note - text the full-profile set
    // already showed (kind labels, card titles) cannot prove the refresh.
    await expect(result.getByText(/Talking points · \d+ cards? from \d+ sources?/)).toBeVisible();
    await expect(result.getByText(/dropped - the sources could not ground them/)).toBeVisible();
    await page.screenshot({ path: `test-results/feature-pixels/person-profile-focus-${vp.name}.png`, style: HIDE_DEV_CHROME });

    // Prove the card grid fits the real viewport: no card is clipped sideways.
    const firstCard = result.locator("li").first();
    const cardBox = await firstCard.boundingBox();
    expect(cardBox, "first card has a box").not.toBeNull();
    expect(cardBox!.x, "card starts inside the viewport").toBeGreaterThanOrEqual(0);
    expect(cardBox!.x + cardBox!.width, "card ends inside the viewport").toBeLessThanOrEqual(vp.width);
  });
}
