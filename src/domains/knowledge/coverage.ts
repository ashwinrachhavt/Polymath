/*
 * Embedding coverage, DERIVED at read time (issue #533 finding 5): no column,
 * no migration. The question is "does the stored chunk set cover this
 * extraction's text?" and the honest answer has three states:
 *
 * - "complete": PROVEN full coverage. Chunks recorded for the extraction's
 *   CURRENT embedModel form the exact contiguous set one transactional pass
 *   writes (indices 0..count-1; (ownerType, ownerId, model, chunkIndex) is
 *   unique), the first chunk starts inside the text's leading whitespace, and
 *   the furthest span end reaches the trimmed text end. chunkText chains
 *   chunks (each start <= previous end), so contiguous indices plus both
 *   endpoints prove no gap anywhere - the furthest endpoint alone never
 *   could, since missing middle/start chunks hide behind a present last one.
 * - "partial": PROVEN cap truncation: the same contiguity and start proofs
 *   hold, the pass wrote exactly MAX_CHUNKS chunks, AND the text continues
 *   past the last chunk's end.
 * - "unknown": everything the evidence cannot establish, and it must never
 *   claim complete: the last pass failed (embedError), no model provenance
 *   recorded (legacy rows), no chunks for the recorded model (never embedded,
 *   or stale rows of another model), a broken index set (missing middle or
 *   start chunks, duplicate rows), an uncovered head, or a tail gap the cap
 *   cannot explain (interrupted run, chunker config drift).
 *
 * Chunk rows are written in one transaction per pass, so a successful pass
 * leaves exactly its own chunk set for its model; anything the derivation
 * cannot prove from that shape is "unknown", never a falsely reassuring
 * "complete".
 */

import { MAX_CHUNKS } from "./chunking";

export type EmbeddingCoverage = "complete" | "partial" | "unknown";

export type CoverageInput = {
  /** documentExtractions.embedModel - the last successful pass's model. */
  embedModel: string | null;
  /** documentExtractions.embedError - set when the LAST pass failed. */
  embedError: string | null;
  /** Length of the extraction text with trailing whitespace trimmed. */
  textLength: number;
  /** Whitespace characters before the first non-blank (chunk 0 may start there). */
  leadingWhitespace: number;
  /** Aggregates over stored chunk rows whose model == embedModel. */
  chunks: {
    count: number;
    minIndex: number | null;
    maxIndex: number | null;
    minSpanStart: number | null;
    maxSpanEnd: number | null;
  };
};

export function deriveCoverage(input: CoverageInput): EmbeddingCoverage {
  // A failed last pass: existing chunks predate it, but nothing proves which
  // pass they came from - never claim complete over a recorded failure.
  if (input.embedError != null) return "unknown";
  // No recorded model: legacy or never-embedded provenance. Chunks may exist
  // but their pass cannot be identified.
  if (input.embedModel == null) return "unknown";
  const c = input.chunks;
  if (c.count === 0 || c.minIndex == null || c.maxIndex == null || c.minSpanStart == null || c.maxSpanEnd == null) {
    return "unknown";
  }
  // The unique (owner, model, chunkIndex) key makes count rows spanning
  // indices 0..count-1 exactly the contiguous set one pass writes. A missing
  // middle chunk (indices 0..count with a hole) or a missing start breaks
  // one equality even when the last chunk is present.
  if (c.minIndex !== 0 || c.maxIndex !== c.count - 1) return "unknown";
  // chunkText only skips LEADING whitespace before chunk 0: a first span
  // starting past it means an uncovered head the index set cannot reveal.
  if (c.minSpanStart > input.leadingWhitespace) return "unknown";
  // Chained spans (each start <= previous end) over a contiguous index set,
  // head covered, tail reached: coverage is proven. The endpoint-touching
  // boundary (maxSpanEnd === textLength) IS complete.
  if (c.maxSpanEnd >= input.textLength) return "complete";
  // A proven-contiguous pass that stopped early exactly at the chunk cap is
  // the cap's work: partial, explicitly.
  if (c.count >= MAX_CHUNKS) return "partial";
  // A tail gap WITHOUT the cap cannot come from one transactional pass:
  // interrupted run or config drift. Unexplainable, so unknown.
  return "unknown";
}
