/*
 * A one-page, text-layer PDF built from plain lines — enough structure for a
 * real PDF reader (xref, Helvetica, one content stream) and nothing else, so
 * journeys can upload a realistic document without a binary fixture. ASCII
 * only: the content stream is written with the standard WinAnsi encoding.
 */

export const SAMPLE_INVOICE_LINES = [
  "INVOICE",
  "Invoice number: INV-2026-0142",
  "Issue date: 2026-10-01",
  "Due date: 11/10/2026",
  "Currency: EUR",
  "",
  "From:",
  "Harbor Lane Carpentry Ltd",
  "billing@harborlane.example",
  "",
  "Bill to:",
  "Maeve Brennan",
  "maeve.brennan@example.org",
  "",
  "Kitchen cabinet repair EUR 840.00",
  "Materials EUR 260.00",
  "Subtotal: EUR 1,100.00",
  "VAT 13.5%: EUR 148.50",
  "Total due: EUR 1,248.50",
];

export function invoicePdf(lines: string[] = SAMPLE_INVOICE_LINES): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const body = lines
    .map((line, i) => `BT /F1 11 Tf 56 ${760 - i * 18} Td (${escape(line)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
