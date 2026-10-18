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
    }
  | { ok: false; error: string; extractor: string };

export interface ExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
