/*
 * Embedding coverage, DERIVED at read time (issue #533 finding 5): no column,
 * no migration. The question is "does the stored chunk set cover this
 * extraction's text?" and the honest answer has three states:
 *
 * - "complete": chunks recorded for the extraction's CURRENT embedModel cover
 *   the text to its end (chunks are contiguous from the first non-whitespace
 *   character with overlap, so max(spanEnd) reaching the trimmed text end
 *   proves coverage).
 * - "partial": coverage is provably cut by the chunk cap: the pass wrote
 *   exactly MAX_CHUNKS chunks AND the text continues past the last chunk.
 * - "unknown": everything else, because the evidence cannot establish
 *   complete and must never claim it: the last pass failed (embedError),
 *   no model provenance recorded (legacy rows), no chunks for the recorded
 *   model (never embedded, or stale rows of another model), or a chunk gap
 *   the cap cannot explain (interrupted pre-transactional legacy data, or a
 *   chunker config change between passes).
 *
 * Chunk rows are written in one transaction per pass, so a successful pass
 * leaves exactly its own chunk set for its model; the derivation trusts that
 * and calls anything it cannot explain "unknown".
 */

import { MAX_CHUNKS } from "./chunking";

export type EmbeddingCoverage = "complete" | "partial" | "unknown";

export type CoverageInput = {
  /** documentExtractions.embedModel - the last successful pass's model. */
  embedModel: string | null;
  /** documentExtractions.embedError - set when the LAST pass failed. */
  embedError: string | null;
  /** Trimmed length of the extraction text. */
  textLength: number;
  /** Aggregates over stored chunk rows whose model == embedModel. */
  chunks: { count: number; maxSpanEnd: number | null };
};

export function deriveCoverage(input: CoverageInput): EmbeddingCoverage {
  // A failed last pass: existing chunks predate it, but nothing proves which
  // pass they came from - never claim complete over a recorded failure.
  if (input.embedError != null) return "unknown";
  // No recorded model: legacy or never-embedded provenance. Chunks may exist
  // but their pass cannot be identified.
  if (input.embedModel == null) return "unknown";
  if (input.chunks.count === 0 || input.chunks.maxSpanEnd == null) return "unknown";
  // Chunks are contiguous from the text start with overlap: reaching the
  // (trimmed) end proves full coverage. The endpoint-touching boundary
  // (maxSpanEnd === textLength) IS complete - the last character is inside.
  if (input.chunks.maxSpanEnd >= input.textLength) return "complete";
  // A gap with the cap hit is the cap's work: partial, explicitly.
  if (input.chunks.count >= MAX_CHUNKS) return "partial";
  // A gap WITHOUT the cap cannot come from one transactional pass: legacy
  // interrupted data or config drift. Unexplainable, so unknown.
  return "unknown";
}
