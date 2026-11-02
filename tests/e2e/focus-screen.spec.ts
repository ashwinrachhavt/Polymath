import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { waitSettled } from "./helpers/settled";

/*
 * The Focus screen's own journey (spec §3): setup with the tier picker and
 * blocklist editor, a live Deep session with its tier-specific controls, the
 * blocked Finish, and the two-step abandon door out to the summary. Unlike
 * the dock spec (which starts a session from a task), this journey starts
 * from the screen itself and never links a task, so the summary is the only
 * record the session leaves. The deep cooldown is 60s, by design: the wait
 * IS the assertion that the door scales with the tier.
 */
function db() {
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

test("focus screen: setup to a deep session's blocked finish through the abandon door to the summary", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const client = db();
  const tag = `screen-${Date.now().toString(36)}`;
  const subject = `Parity deep pass (${tag})`;
  const blockPattern = `${tag}.example`;
  try {
    // Setup: the screen is a real destination with its own tier picker and
    // blocklist editor.
    await page.goto("/neuralflow/focus");
    await waitSettled(page);
    await expect(page.locator("#content h1")).toHaveText("Focus");
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
    await expect(page.getByText(/Nothing blocked yet\./)).toBeVisible();

    // Blocklist editor: add a pattern, see it, archive it.
    await page.getByLabel("Site or pattern").fill(blockPattern);
    await page.getByRole("button", { name: "Add entry" }).click();
    const row = page.getByRole("listitem").filter({ hasText: blockPattern });
    await expect(row).toBeVisible();
    await expect(row).toContainText("block");
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(row).toBeHidden();

    // Tier picker: Deep's copy is generated from the constants the server
    // enforces, so the visible promise is the contract.
    await page.locator('input[name="strictness"][value="deep"]').check();
    await expect(page.getByText("No pauses.", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Abandon cools down 60s/).first()).toBeVisible();

    await page.getByLabel("What are you focusing on?").fill(subject);
    await page.getByLabel("Planned minutes").fill("5");

    // Start. The workspace runs one session; a sibling test may hold the slot,
    // so retry until the start lands.
    await expect(async () => {
      await page.getByRole("button", { name: "Start focusing" }).click();
      await expect(page.getByRole("heading", { name: "Start a session" })).toBeHidden({ timeout: 10_000 });
    }).toPass({ timeout: 60_000, intervals: [3_000] });

    // Live, Deep tier: the clock runs and Pause is absent - the tier's core
    // promise, asserted in the negative.
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.getByText("Deep", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    // The dock anchors to this screen: while the session is live HERE the
    // ghost is absent; elsewhere it appears.
    await expect(page.getByLabel("Focus session")).toBeHidden();
    await page.goto("/command-center/inbox");
    const dock = page.getByLabel("Focus session");
    // The dock's first read pays the dev-mode compile of /api/v1/focus/live;
    // a fresh server (CI shard or this run's first hit) can spend the default
    // 5s inside that compile, so the dock gets the same courtesy as Start.
    await expect(dock).toBeVisible({ timeout: 20_000 });
    await expect(dock).toContainText("Focus running");
    await expect(dock).toContainText(subject);

    // Back on the screen the live view is the server's state, rederived.
    await page.goto("/neuralflow/focus");
    await expect(page.getByRole("timer")).toBeVisible();

    // The blocked finish: Deep holds for the full plan, and the guard says
    // how much is left.
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(page.getByText(/Deep focus holds for the full 5 minutes/)).toBeVisible();

    // The abandon door: request first, confirm only after the cooldown.
    await page.getByRole("button", { name: "Abandon", exact: true }).click();
    await expect(page.getByText("Abandon requested", { exact: true })).toBeVisible();
    const confirm = page.getByRole("button", { name: "Confirm abandon" });
    await expect(confirm).toBeDisabled();
    await expect(page.getByText(/You can abandon in \d+s/)).toBeVisible();
    // The timer keeps running while the door is open.
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(confirm).toBeEnabled({ timeout: 90_000 });
    await expect(page.getByText("The door is open.", { exact: true })).toBeVisible();
    await confirm.click();

    // Summary: the abandoned record, from the durable row.
    await expect(page.getByText("Abandoned", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: subject })).toBeVisible();
    await expect(page.getByText(/5 min planned/)).toBeVisible();
    // The state is in Postgres: a reload lands on setup + the same summary.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
    await expect(page.getByText("Abandoned", { exact: true })).toBeVisible();
  } finally {
    // A crashed journey may leave the session live. Closing it through the UI
    // (request + confirm, or confirm if the door is already open) revalidates
    // the focus cache the way a real close does; deleting the row by SQL
    // alone would leave the cached reads claiming a live session for the
    // next run.
    if (client) {
      try {
        const confirm = page.getByRole("button", { name: "Confirm abandon" });
        if ((await page.getByText("Abandon requested", { exact: true }).count()) === 0) {
          const abandon = page.getByRole("button", { name: "Abandon", exact: true });
          if (await abandon.count()) await abandon.click();
        }
        if (await confirm.count()) {
          await confirm.click({ timeout: 90_000 }).catch(() => {});
        }
      } catch {
        // Best effort: the SQL delete below still removes the row.
      }
      await client`delete from focus_sessions where subject = ${subject}`;
      await client`delete from focus_blocklist where pattern = ${blockPattern}`;
      await client.end();
    }
  }
});
