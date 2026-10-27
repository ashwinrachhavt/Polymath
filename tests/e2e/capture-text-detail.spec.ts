import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * The plain-text capture through the detail pane.
 *
 * voice-capture.spec.ts covers the audio path and ingestion-selection.spec.ts
 * covers the companion's selection path. Neither drives a text capture that
 * has no URL at all, which is the most common way work arrives and the shape
 * the inbox detail pane has to get right: body present, nothing to fetch,
 * both filing actions offered.
 *
 * The distinction that matters: a text capture has no pending fetch, so the
 * pane must not promise one. A retry affordance or a "fetching" line on a
 * capture with nothing to fetch is the defect this pins.
 */

type CaptureRow = { id: string };

async function createTextCapture(page: import("@playwright/test").Page, text: string): Promise<string> {
  const response = await page.request.post("/api/v1/captures", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { text },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { capture: CaptureRow };
  return body.capture.id;
}

test("a text capture reads as its own body with nothing to fetch", async ({ page }) => {
  const unique = `e2e-plain-capture-${Date.now()}`;
  const id = await createTextCapture(page, `${unique} — the words the owner actually typed.`);

  await page.goto(`/command-center/inbox?id=${id}`);
  await waitSettled(page);

  // Invariant 1: the capture opens on its own row and the body is the working
  // text. This is the whole contract of a text capture.
  await expect(page).toHaveURL(new RegExp(`/command-center/inbox\\?id=${id}$`));
  const detail = page.getByRole("article");
  await expect(detail.getByText(unique, { exact: false })).toBeVisible();

  // Invariant 2: nothing to fetch means no fetch affordance. Retry exists for
  // a URL whose read failed; offering it here would be a control that cannot
  // do anything, or worse, implies the text is incomplete when it is not.
  await expect(detail.getByRole("button", { name: /retry/i })).toHaveCount(0);

  // Invariant 3: both filing actions are available on text.
  await expect(detail.getByRole("button", { name: "Save as note", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Save to library", exact: true })).toBeVisible();
});

test("a capture with nothing to fetch never shows a fetch-state line", async ({ page }) => {
  const id = await createTextCapture(page, `e2e-no-fetch-state-${Date.now()}`);
  await page.goto(`/command-center/inbox?id=${id}`);
  await waitSettled(page);

  // A text capture has no URL, so no read is in flight and none can have
  // failed. The pane renders the body, not a status about the body.
  const detail = page.getByRole("article");
  await expect(detail.getByText(/reading the page|fetching|could not be fetched/i)).toHaveCount(0);
});
