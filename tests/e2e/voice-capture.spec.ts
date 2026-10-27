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

/*
 * The dispatcher claims the 10 oldest pending events per pass, and the shared
 * e2e workspace's outbox holds every parallel spec's events - one pass is not
 * guaranteed to reach this capture's row. Drain in passes until the
 * transcript renders; each pass is a real dispatcher run, so the wait is the
 * product's own async contract, not a sleep.
 */
async function drainUntilTranscript(page: import("@playwright/test").Page, detail: import("@playwright/test").Locator) {
  for (let pass = 0; pass < 12; pass += 1) {
    await drainOutbox(page);
    await page.reload();
    await waitSettled(page);
    if (await detail.getByText("Fixture transcript:", { exact: false }).count()) return;
  }
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
  // has not landed yet says so plainly - no words to convert yet. The hint
  // states this deployment's truth, so it names whichever applies: the
  // transcript is on its way, or transcription could not run at all and the
  // capture carries the reason (TRANSCRIPTION_PROVIDER unset). Asserting the
  // state rather than one sentence keeps the journey honest in both harnesses.
  await expect(page).toHaveURL(/\/command-center\/inbox\?id=[0-9a-f-]{36}$/);
  const detail = page.getByRole("article");
  await expect(detail.getByText("Voice", { exact: true })).toBeVisible();
  await expect(detail.getByText(/transcription (is not configured|runs)/i).first()).toBeVisible();
  await expect(detail.getByRole("button", { name: "Save as note", exact: true })).toHaveCount(0);

  // Deliberate dispatcher passes: transcription is async by design, and the
  // shared outbox may need several claim batches to reach this capture.
  await drainUntilTranscript(page, detail);

  // The fixture's words are the capture's text; conversion affordances return.
  await expect(detail).toContainText("Fixture transcript: send the Q3 roadmap to Priya by Friday");
  await expect(detail.getByRole("button", { name: "Make task", exact: true })).toBeVisible();
});
