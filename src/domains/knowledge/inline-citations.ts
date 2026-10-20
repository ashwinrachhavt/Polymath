import type { DocumentCitation } from "@/domains/knowledge/agent-search";

/*
 * Inline numbered citations, the NotebookLM gesture: an answer carries [1] [2]
 * markers that point at a numbered source list, and clicking a marker jumps to
 * the passage.
 *
 * The model is asked to write `[[n]]` where n is the position in the citation
 * list it was given. This module turns that into segments the renderer can lay
 * out. A marker that names no citation is dropped rather than rendered as a
 * dead number, because a citation that goes nowhere is worse than none.
 */

export type CitationSegment =
  | { type: "text"; text: string }
  | { type: "citation"; index: number; citation: DocumentCitation };

/** `[[3]]`, and the looser `[3]` a model sometimes writes anyway. */
const MARKER = /\[\[(\d{1,3})\]\]|\[(\d{1,3})\]/g;

/**
 * Splits an answer into text and citation segments. Indices are 1-based in the
 * text and 0-based in the returned segment, because the renderer numbers the
 * list and the citation array is what it numbers.
 */
export function splitCitations(answer: string, citations: DocumentCitation[]): CitationSegment[] {
  if (citations.length === 0) return [{ type: "text", text: answer }];

  const segments: CitationSegment[] = [];
  let cursor = 0;
  for (const match of answer.matchAll(MARKER)) {
    const raw = match[1] ?? match[2];
    const position = Number(raw) - 1;
    const citation = citations[position];
    if (!citation) continue; // a number with no source is dropped
    const at = match.index ?? 0;
    if (at > cursor) segments.push({ type: "text", text: answer.slice(cursor, at) });
    segments.push({ type: "citation", index: position, citation });
    cursor = at + match[0].length;
  }
  if (cursor < answer.length) segments.push({ type: "text", text: answer.slice(cursor) });
  return segments.length > 0 ? segments : [{ type: "text", text: answer }];
}

/**
 * The prompt fragment that teaches the model the marker convention. Kept here
 * so the parser and the instruction cannot drift.
 */
export const CITATION_INSTRUCTION =
  "Cite the sources you use inline as [[n]], where n is the source's number in the list you were given. Put the marker at the end of the sentence it supports. Do not invent a number that is not in the list.";

/**
 * A citation list with one entry per document, in first-seen order, so the
 * numbers in an answer stay stable when the same document is cited twice.
 */
export function numberedCitations(citations: DocumentCitation[]): Array<{ index: number; citation: DocumentCitation }> {
  const seen = new Map<string, { index: number; citation: DocumentCitation }>();
  const out: Array<{ index: number; citation: DocumentCitation }> = [];
  for (const citation of citations) {
    const key = `${citation.documentId}:${citation.span.start}`;
    if (seen.has(key)) continue;
    const entry = { index: out.length, citation };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}
