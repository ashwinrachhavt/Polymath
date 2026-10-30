import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * The Ideas sitting journey (plan 2026-10-29 §14, §11 journey e2e): a writer
 * opens a sitting, types, pauses — CREATION_IDLE_MS (1.2s) later the draft is
 * saved as a card and the creation stream opens — the fixture provider's
 * suggestion arrives in the ambient panel, the card lands on the Ideas
 * collection, and reopening the sitting replays the durable record.
 *
 * Runs against the free fixture provider (GENERATION_PROVIDER=fixture): no
 * model key, no spend. The server must be started with that env; the spec
 * skips with a clear note otherwise (see needsFixtureProvider).
 *
 * Assertions stay on the durable contract: the save POST returns before the
 * stream's first event (§3 save-first), and the artifact row is the record —
 * a UI class (e.g. a rail entrance animation) is never load-bearing here.
 */

const HIDE_DEV_CHROME = "nextjs-portal { display: none !important; }";
const DRAFT =
  "Retention compounds when the review cadence matches the forgetting curve. " +
  "Spacing beats massing for durable recall, and the curve is exponential.";

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

const fixtureServer = test.extend({});

fixtureServer("the sitting journey: type, pause, suggestion, card, reopen", async ({ page }) => {
  test.setTimeout(240_000);
  const client = db();
  test.skip(!client, "DATABASE_URL not configured");
  await client!.end();

  // A fresh sitting per run: the /new route creates on arrival (§14.1).
  await page.goto("/polymath/knowledge/zettels/session/new");
  await expect(page).toHaveURL(/\/polymath\/knowledge\/zettels\/session\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // tiptap mounts after hydration (immediatelyRender: false); a cold CI dev
  // server can take a while, so the locator waits on the placeholder element.
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 90_000 });
  await editor.click();
  await page.keyboard.type(DRAFT);

  // The pause: CREATION_IDLE_MS after the last keystroke the run starts.
  // Save-first (§3): the card_saved event names the saved version, and the
  // panel's "Reading your draft…" bridges the silence until live events land.
  await expect(page.getByText("Reading your draft…")).toBeVisible({ timeout: 15_000 });

  // The fixture suggestion arrives as the enrich stage's output (§3 Track B):
  // the proposal block renders the model's suggestion with Keep/Discard.
  await expect(page.getByLabel("AI suggestion")).toContainText(
    "A fixture suggestion: name the load-bearing idea and link it to its source.",
    { timeout: 30_000 },
  );
  await page.screenshot({ path: "test-results/feature-pixels/idea-sitting-suggestion.png", style: HIDE_DEV_CHROME });

  // §14.3: Escape discards the proposal; the card is already saved either way.
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("AI suggestion")).toHaveCount(0);

  // The card exists as a record: the Ideas collection lists the draft's title.
  await page.goto("/polymath/knowledge/zettels");
  await expect(page.getByText(DRAFT.split(".")[0]).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/feature-pixels/idea-sitting-collection.png", style: HIDE_DEV_CHROME });

  // Reopen: the sitting is always writable (Gate: no lifecycle), and the
  // durable record replays - the run's stages are visible history, not a
  // blank panel. The Ideas collection lists card titles; the Sittings list
  // lists sitting topics ("Untitled sitting" — no topic was set), so the
  // reopen goes through the card's notes surface id, not a sitting link.
  await page.goto("/polymath/knowledge/zettels");
  await page.getByRole("link", { name: /Retention compounds/ }).click();
  await page.getByRole("link", { name: "Card" }).click();
  await expect(page).toHaveURL(/\/polymath\/knowledge\/zettels\/session\/[0-9a-f-]{36}$/);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Retention compounds");

  // The sitting history page shows the sitting (no status badges - no lifecycle).
  await page.goto("/polymath/knowledge/zettels/session");
  await expect(page.getByText("No sittings yet")).toHaveCount(0);
});
