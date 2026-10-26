import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * ASH-298: the voice journey end to end. A fake mic records a tone, the
 * upload sniffs as a voice capture, one deliberate outbox pass transcribes
 * through the deterministic fixture adapter, and the transcript - the
 * capture's words - is what the owner reads and converts. No model key, no
 * spend, no real audio.
 */
async function drainOutbox(page: import("@playwright/test").Page) {
  const response = await page.request.post("/api/internal/outbox", {
    headers: { authorization: "Bearer e2e-outbox" },
  });
  expect(response.ok()).toBe(true);
}

test("a voice note records, transcribes, and converts like any capture", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await page.goto("/command-center/inbox");
  await waitSettled(page);

  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Voice note", exact: true }).click();
  await dialog.getByRole("button", { name: "Stop and save", exact: true }).click();

  // The upload navigates to the new capture: a voice note whose transcript
  // has not landed yet behaves like a file - no words to convert.
  await expect(page).toHaveURL(/\/command-center\/inbox\?id=[0-9a-f-]{36}$/);
  const detail = page.getByRole("article");
  await expect(detail).toContainText("Voice note");
  await expect(detail.getByRole("button", { name: "Save as note", exact: true })).toHaveCount(0);

  // One deliberate dispatcher pass: transcription is async by design.
  await drainOutbox(page);
  await page.reload();
  await waitSettled(page);

  // The fixture's words are the capture's text; conversion affordances return.
  await expect(detail).toContainText("Fixture transcript: send the Q3 roadmap to Priya by Friday");
  await expect(detail.getByRole("button", { name: "Make task", exact: true })).toBeVisible();
});
