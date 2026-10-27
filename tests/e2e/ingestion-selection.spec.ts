import { expect, test } from "@playwright/test";
import { waitSettled } from "./helpers/settled";

/*
 * The companion's selection journey.
 *
 * A selection is the words a person chose on a page: the text is the capture,
 * and the address is only where it came from. Two things must hold in the
 * detail pane. The selection stays the working text - never replaced by the
 * page's reading - and the URL shows as provenance beside it, not as the
 * content. And because a selection is never fetched (0136bf0), the pane offers
 * no retry: a control there would promise a read that is not part of this
 * capture's contract.
 *
 * The capture is posted through the real API rather than by driving the
 * extension, the same way voice-capture.spec.ts posts its fixture: the route
 * is the wire the companion uses, and it is what decides the mode.
 */

type CaptureRow = { id: string; url: string | null; text: string | null };

async function createSelection(
  page: import("@playwright/test").Page,
  input: { text: string; url: string },
): Promise<CaptureRow> {
  const response = await page.request.post("/api/v1/captures", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: { text: input.text, url: input.url, mode: "selection" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { capture: CaptureRow };
  return body.capture;
}

test("a selection is the working text with its page as provenance, and is never fetched", async ({ page }) => {
  // A fresh address and body per run: identity is (workspace, source, url,
  // mode, content hash), so a repeat would dedupe onto the previous run's row.
  const stamp = Date.now();
  const url = `https://example.com/e2e-selection/${stamp}`;
  const selection = `e2e selection ${stamp}: the sentence the reader chose on the page.`;

  const created = await createSelection(page, { text: selection, url });
  // The route stores the selection's own words; the address is not the body.
  expect(created.text).toBe(selection);
  expect(created.url).toBe(url);

  await page.goto(`/command-center/inbox?id=${created.id}`);
  await waitSettled(page);

  const detail = page.getByRole("article");

  // The selection is the reading text. A fetch never replaces it.
  await expect(detail.getByText(selection, { exact: false })).toBeVisible();

  // The page it came from is shown as provenance: a link to the address,
  // separate from the words in the body.
  const origin = detail.getByRole("link", { name: url, exact: true });
  await expect(origin).toBeVisible();
  await expect(origin).toHaveAttribute("href", url);

  // A selection enqueues no page fetch, so there is nothing to retry. This is
  // the invariant the pane must not break by offering fetch state on every
  // capture that carries a URL.
  await expect(detail.getByRole("button", { name: /retry/i })).toHaveCount(0);
  await expect(detail.getByText(/reading the page|could not be read/i)).toHaveCount(0);
});
