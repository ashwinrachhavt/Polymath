/*
 * The one shape extraction adapters implement. Adapters live beside this file
 # (docling-docker.ts local, hosted free-tier remote); domain code sees only
 * this contract, and `document_extractions.extractor` records which one ran.
 */
export type ExtractionInput = {
  /** Raw bytes of the document. */
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
};

export type ExtractionSpan = { page: number; start: number; end: number };

export type ExtractionResult =
  | {
      ok: true;
      text: string;
      spans: ExtractionSpan[];
      pageCount: number | null;
      /** Recorded in document_extractions.extractor, e.g. "docling-serve@local". */
      extractor: string;
    }
  | { ok: false; error: string; extractor: string };

export interface ExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
