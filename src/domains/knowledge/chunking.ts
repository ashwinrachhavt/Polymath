import type { ExtractionSpan } from "@/integrations/extraction/provider";

/*
 * Splits extracted text into passages for embedding. Pure, so it is tested
 * without a database. A chunk keeps its character offsets into the extraction
 * text, which are the same coordinates `document_extractions.spans` uses, so a
 * search hit can open the exact evidence and say which page it came from.
 */

export type Chunk = { index: number; text: string; start: number; end: number; page: number | null };

export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 150;
/** A 4 MB upload cannot become an unbounded bill: past this many chunks the rest is not embedded. */
export const MAX_CHUNKS = 400;

/** Prefer to end a chunk at a paragraph break, then a sentence, then a space. */
function breakPoint(text: string, from: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;
  const window = text.slice(from, hardEnd);
  const floor = Math.floor(window.length * 0.5);
  const para = window.lastIndexOf("\n\n");
  if (para >= floor) return from + para + 2;
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentence >= floor) return from + sentence + 2;
  const space = window.lastIndexOf(" ");
  if (space >= floor) return from + space + 1;
  return hardEnd;
}

export function chunkText(
  text: string,
  spans: ExtractionSpan[] = [],
  options: { target?: number; overlap?: number; max?: number } = {},
): Chunk[] {
  const target = options.target ?? CHUNK_TARGET_CHARS;
  const overlap = Math.min(options.overlap ?? CHUNK_OVERLAP_CHARS, Math.floor(target / 2));
  const max = options.max ?? MAX_CHUNKS;
  const chunks: Chunk[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < max) {
    // Skip leading whitespace so a chunk never starts on a blank.
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (cursor >= text.length) break;
    const end = breakPoint(text, cursor, Math.min(cursor + target, text.length));
    const raw = text.slice(cursor, end);
    const piece = raw.trim();
    if (piece) {
      const start = cursor + (raw.length - raw.trimStart().length);
      chunks.push({
        index: chunks.length,
        text: piece,
        start,
        end: start + piece.length,
        page: pageAt(spans, start),
      });
    }
    if (end >= text.length) break;
    // Step forward, keeping an overlap, and always make progress.
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

function pageAt(spans: ExtractionSpan[], offset: number): number | null {
  const hit = spans.find((s) => offset >= s.start && offset < s.end);
  return hit ? hit.page : null;
}
