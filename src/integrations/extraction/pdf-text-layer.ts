import { extractText, getDocumentProxy } from "unpdf";
import type { ExtractionInput, ExtractionProvider, ExtractionResult } from "./provider";
import { normalizePageText } from "./cleanup";

/*
 * The development-only reader: the text layer a PDF already carries, read in
 * process with unpdf (pdf.js built for server runtimes). No OCR, so a scanned
 * PDF or an image is a failed extraction that names the provider it needs,
 * never an empty success. Resolution in the knowledge domain only picks this
 * when no hosted or docker provider is configured and NODE_ENV is not
 * production.
 */

const PAGE_BREAK = "\n\n";

export function createPdfTextLayerProvider(): ExtractionProvider {
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = "pdf-text-layer@local";
      if (input.mimeType !== "application/pdf") {
        return {
          ok: false,
          error: "The local reader only reads PDF text. Reading images needs DOCLING_SERVE_URL or LLAMAPARSE_API_KEY.",
          extractor,
        };
      }

      let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
      try {
        pdf = await getDocumentProxy(new Uint8Array(input.bytes));
        const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });

        // Per-page spans over the joined text, so evidence opens on its page.
        // Cleanup per page, before the join: offsets stay correct.
        let text = "";
        const spans = pages.map((pageText, index) => {
          if (index > 0) text += PAGE_BREAK;
          const start = text.length;
          text += normalizePageText(pageText);
          return { page: index + 1, start, end: text.length };
        });
        if (!text.trim()) {
          return {
            ok: false,
            error: "This PDF has no text layer, so it is probably a scan. Reading it needs DOCLING_SERVE_URL or LLAMAPARSE_API_KEY.",
            extractor,
          };
        }
        return { ok: true, text, spans, pageCount: totalPages, extractor };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: `The PDF could not be read: ${message.slice(0, 200)}`, extractor };
      } finally {
        await pdf?.loadingTask.destroy();
      }
    },
  };
}
