import { expect, test } from "@playwright/test";

import { seedAgentProposal, removeSeededProposals } from "./helpers/proposals";
import { seedTask, cleanupSeededTasks } from "./helpers/tasks";
import { waitSettled } from "./helpers/settled";

/*
 * ASH-306 from the outside: asking for a surface in the home composer is
 * answered by the product, not a model run - the exchange renders in place
 * with a card of real rows, and the card deep-links to the full surface.
 * Seeded rows use the per-test marker so parallel journeys never read each
 * other's data; the same account is one record, so these journeys stay
 * sequential within the file.
 */

const MARKER = `e2e-nav-${crypto.randomUUID().slice(0, 8)}`;

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await removeSeededProposals();
  await cleanupSeededTasks();
});

test("asking for decisions answers in place with the real pending proposal", async ({ page }) => {
  const title = `${MARKER} approve the keynote invoice`;
  const seeded = await seedAgentProposal({ title, effect: "sends the invoice", riskClass: "prepare" });
  test.skip(!seeded, "No database configured for seeding.");

  await page.goto("/alfred");
  await page.getByLabel("Start a conversation").fill("show my decisions");
  await page.getByLabel("Start a conversation").press("Enter");
  await waitSettled(page);

  const card = page.getByLabel("Waiting on your decision");
  await expect(card).toBeVisible();
  await expect(card.getByText(title)).toBeVisible();
  // The card is a window, not a trap: the door to the full surface is there.
  await expect(card.getByRole("link", { name: "Open" })).toBeVisible();
  // Deterministic answer, no model run: no streaming surface mounts.
  await expect(page.getByLabel("Start a conversation")).toHaveCount(0);
});

test("asking for open tasks lists the seeded task with its deep link", async ({ page }) => {
  const title = `${MARKER} review the board deck`;
  const seeded = await seedTask({ title });
  test.skip(!seeded, "No database configured for seeding.");

  await page.goto("/alfred");
  await page.getByLabel("Start a conversation").fill("show me my open tasks");
  await page.getByLabel("Start a conversation").press("Enter");
  await waitSettled(page);

  const card = page.getByLabel("Open tasks");
  await expect(card).toBeVisible();
  const link = card.getByRole("link", { name: title });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", `/neuralflow/work?task=${seeded!.id}`);
});

test("ordinary conversation still takes the model path", async ({ page }) => {
  await page.goto("/alfred");
  const composer = page.getByLabel("Start a conversation");
  await composer.fill("what did I capture yesterday");
  await composer.press("Enter");
  // No navigation card: the message is not a navigation phrase. The run path
  // may fail in e2e without a live Eve runtime, but it must not answer with
  // a surface card.
  await expect(page.getByLabel("Waiting on your decision")).toHaveCount(0);
  await expect(page.getByLabel("Open tasks")).toHaveCount(0);
});
