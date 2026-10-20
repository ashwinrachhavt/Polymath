import { expect, test } from "@playwright/test";
import { invoicePdf, SAMPLE_INVOICE_LINES } from "./helpers/invoice-pdf";

/*
 * The back-office loop the pilot users must finish unaided: add a document,
 * read it, correct an ambiguous value, link the right parties, accept the
 * follow-up, and find the evidence again. Needs the real database and the
 * development object store and text-layer reader, so it skips without one.
 */
test.skip(!process.env.DATABASE_URL, "Document review needs DATABASE_URL (server and test).");

test("an invoice goes from upload to corrected fields, linked parties, a follow-up and search", async ({ page, request }) => {
  test.setTimeout(120_000);
  const run = crypto.randomUUID().slice(0, 8).toUpperCase();
  const invoiceNumber = `INV-${run}`;
  const lines = SAMPLE_INVOICE_LINES.map((line) => line.replace("INV-2026-0142", invoiceNumber));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Compile the upload route before the timed user journey, without writing a
  // file: its GET rejects a missing documentId before querying any documents.
  const warmup = await request.get("/api/v1/files");
  expect(warmup.status()).toBe(400);

  await page.goto("/alfred/knowledge");
  await page.locator('input[type="file"]').first().setInputFiles({ name: `invoice-${run}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(invoicePdf(lines)) });
  // The upload toast is async server feedback; loaded CI runners take well over the 5s default.
  await expect(page.getByRole("status").filter({ hasText: "added. Reading starts on its own" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("link", { name: `invoice-${run}`, exact: true }).click();
  // Uploading already starts the read in the background, so "Read now" only
  // remains for a row the read never started on. Click it when it is there,
  // then reload until the proposals land - the page is server-rendered and
  // does not stream the extraction's completion.
  const readNow = page.getByRole("button", { name: "Read now" });
  if (await readNow.isVisible().catch(() => false)) await readNow.click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Proposed by text rules, not AI.")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [2_000, 5_000] });

  const field = (label: string) => page.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });
  await expect(field("invoice number")).toContainText(`Read from: Invoice number: ${invoiceNumber}`);
  await field("invoice number").getByRole("button", { name: "Accept" }).click();

  const due = field("due date");
  await expect(due).toContainText("Confidence: low.");
  await due.getByRole("button", { name: "Edit" }).click();
  await due.getByRole("textbox").fill("2026-11-10");
  await due.getByRole("button", { name: "Save value" }).click();

  await field("tax").getByRole("button", { name: "Reject" }).click();
  await field("issuer email").getByRole("button", { name: "Accept" }).click();
  await field("recipient email").getByRole("button", { name: "Accept" }).click();
  await field("invoice total").getByRole("button", { name: "Accept" }).click();
  for (const label of ["invoice number", "due date", "issuer email", "recipient email", "invoice total"]) {
    await expect(field(label).getByRole("button", { name: "Accept" }), label).toHaveCount(0);
  }
  await expect(field("tax")).toContainText(/rejected/i);

  const parties = page.getByRole("heading", { name: "People and companies" }).locator("..");
  await parties.getByRole("listitem").filter({ hasText: "Harbor Lane Carpentry Ltd" }).getByRole("button", { name: "Create new company" }).click();
  await parties.getByRole("listitem").filter({ hasText: "Maeve Brennan" }).getByRole("button", { name: "Create new contact" }).click();
  await expect(parties.getByRole("button", { name: /Create new/ })).toHaveCount(0);

  const followUp = page.getByRole("listitem").filter({ hasText: "Confirm whether it was paid" });
  await followUp.getByRole("button", { name: "Accept" }).click();
  await expect(followUp.getByRole("button", { name: "Accept" })).toHaveCount(0);

  await page.goto("/alfred/knowledge");
  await page.getByRole("searchbox", { name: "Search knowledge" }).fill(invoiceNumber);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: `invoice-${run}`, exact: true }).first()).toBeVisible();
  // Full-text search splits the number at the hyphen, so each part is marked.
  await expect(page.locator("mark").filter({ hasText: run }).first()).toBeVisible();
  await expect(page.getByText(`invoice-${run}.pdf · PDF · Harbor Lane Carpentry Ltd, Maeve Brennan`)).toBeVisible();
  expect(errors).toEqual([]);
});
