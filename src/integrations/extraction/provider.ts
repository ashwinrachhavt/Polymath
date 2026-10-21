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

/*
 * A table as the provider saw it, in our own shape. Only providers that return
 * cell coordinates can fill this; the statement ledger depends on the grid, so
 * a provider that cannot produce it leaves `tables` off and the statement parse
 * reports the document as unsupported rather than guessing.
 */
export type ExtractedTable = {
  page: number | null;
  numRows: number;
  numCols: number;
  cells: Array<{ row: number; col: number; text: string; header: boolean; rowSpan: number; colSpan: number }>;
};

/** A structured field a provider already reported. Normalization is the domain's job.
 * fieldKind is derived from the schema enum so the two lists cannot drift. */
import type { FieldKind, documentPartyRole } from "@/domains/knowledge/schema";

export type ExtractedField = {
  fieldKind: FieldKind;
  fieldName: string;
  rawValue: string;
  normalizedValue?: unknown;
  normalizationNote?: string;
  confidence?: string;
  evidenceSpans: Array<{ page?: number; start: number; end: number }>;
  /** The party whose block the value was read from; absent for document-level facts. */
  partyRole?: (typeof documentPartyRole.enumValues)[number];
};

export type ExtractionResult =
  | {
      ok: true;
      text: string;
      spans: ExtractionSpan[];
      pageCount: number | null;
      /** Recorded in document_extractions.extractor, e.g. "docling-serve@local". */
      extractor: string;
      /** Optional structured output; adapters that do not produce it leave it off. */
      fields?: ExtractedField[];
      /** Optional table grid, for consumers that need cell coordinates. */
      tables?: ExtractedTable[];
    }
  | { ok: false; error: string; extractor: string };

export interface ExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
