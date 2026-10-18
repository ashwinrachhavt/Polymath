import type { ExtractionInput, ExtractionProvider, ExtractionResult } from "./provider";

/*
 * A text file is its own extraction: the bytes are the reading text, in every
 * environment, with no provider to configure. Captured web pages
 * (text/markdown) come through here, so a page extracts the same way on a
 * laptop, in CI, and on Vercel, without spending a hosted parse on it.
 */
export function createPlainTextProvider(): ExtractionProvider {
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = "plain-text@local";
      const text = new TextDecoder("utf-8").decode(input.bytes);
      if (!text.trim()) {
        return { ok: false, error: "The file has no readable text.", extractor };
      }
      return {
        ok: true,
        text,
        spans: [{ page: 1, start: 0, end: text.length }],
        pageCount: 1,
        extractor,
      };
    },
  };
}
