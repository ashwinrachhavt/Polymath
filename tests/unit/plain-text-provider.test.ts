import { describe, expect, it } from "vitest";
import { createPlainTextProvider } from "@/integrations/extraction/plain-text";

describe("plain-text extraction provider", () => {
  it("returns the file bytes as one page of text", async () => {
    const bytes = new TextEncoder().encode("# Title\n\nBody text.");
    const result = await createPlainTextProvider().extract({ bytes, filename: "doc", mimeType: "text/markdown" });
    expect(result).toEqual({
      ok: true,
      text: "# Title\n\nBody text.",
      spans: [{ page: 1, start: 0, end: bytes.byteLength }],
      pageCount: 1,
      extractor: "plain-text@local",
    });
  });

  it("fails an empty file instead of minting an empty success", async () => {
    const result = await createPlainTextProvider().extract({ bytes: new Uint8Array(), filename: "doc", mimeType: "text/plain" });
    expect(result).toMatchObject({ ok: false, extractor: "plain-text@local" });
  });
});
