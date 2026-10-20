import { describe, expect, it } from "vitest";
import { samplePdf } from "../../scripts/smoke/extraction-providers.mts";

describe("smoke sample PDF generator", () => {
  it("emits a byte-accurate one-page PDF: header, xref offsets, trailer, EOF", () => {
    const bytes = samplePdf();
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    // Every xref offset must point at its "N 0 obj" marker.
    const xref = /xref\n0 6\n0000000000 65535 f \n((?:\d{10} \d{5} n \n){5})/.exec(text);
    expect(xref).not.toBeNull();
    const offsets = xref![1]!.trim().split("\n").map((line) => Number(line.slice(0, 10)));
    const objects = [0, 1, 2, 3, 4].map((i) => `${i + 1} 0 obj`);
    offsets.forEach((offset, i) => {
      expect(text.slice(offset, offset + objects[i]!.length)).toBe(objects[i]);
    });
  });

  it("round-trips through the pdf text-layer reader as a real extraction", async () => {
    const { createPdfTextLayerProvider } = await import("../../src/integrations/extraction/pdf-text-layer");
    const result = await createPdfTextLayerProvider().extract({
      bytes: samplePdf(),
      filename: "fixture.pdf",
      mimeType: "application/pdf",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pageCount).toBe(1);
      expect(result.text).toContain("Polymath smoke test");
    }
  });
});
