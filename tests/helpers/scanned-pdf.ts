import { PDFDocument } from "pdf-lib";

/*
 * A scanned-style PDF fixture: real pages that carry an image and no text
 * layer, built with the same pdf-lib the OCR adapter splits with. The floor
 * reader must refuse it (nothing to read) and the OCR adapter must treat it
 * as page work — the two properties the scan journey depends on.
 */

/** Smallest valid PNG (1x1, transparent). */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export async function scannedPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(Buffer.from(TINY_PNG, "base64"));
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}
