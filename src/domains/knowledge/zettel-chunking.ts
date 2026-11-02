/*
 * Splits a source text into bounded sections so the zettelizer reads long
 * documents in full: every heading-bounded piece is at most
 * ZETTEL_SECTION_MAX_CHARS (the extractor's own cap, so a section is never
 * truncated by it), at most ZETTEL_MAX_SECTIONS are read, and anything past
 * that is counted — `unreadChars` / `unreadSections` — never silently
 * dropped. `start`/`end` are offsets into the ORIGINAL text, so a quote
 * located inside a section maps back to source coordinates unchanged.
 */

export const ZETTEL_SECTION_MAX_CHARS = 12_000;
export const ZETTEL_MAX_SECTIONS = 12;
/** The cap the merge pass may keep per source; replaces the flat 8. */
export const ZETTEL_MERGE_MAX_PER_SOURCE = 20;

export type ZettelSection = { text: string; start: number; end: number };

const HEADING_BOUNDARY = /^#{1,6} .+$/gm;

/** One span over the cap is cut at its last paragraph break, else hard at the cap. */
function splitOversized(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  const pieces: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor <= ZETTEL_SECTION_MAX_CHARS) {
      pieces.push({ start: cursor, end });
      break;
    }
    const window = text.slice(cursor, cursor + ZETTEL_SECTION_MAX_CHARS);
    const break_ = window.lastIndexOf("\n\n");
    const cut = break_ > 0 ? cursor + break_ + 2 : cursor + ZETTEL_SECTION_MAX_CHARS;
    pieces.push({ start: cursor, end: cut });
    cursor = cut;
  }
  return pieces;
}

export function splitSections(text: string): {
  sections: ZettelSection[];
  readChars: number;
  unreadChars: number;
  unreadSections: number;
} {
  // Boundaries are absolute offsets: the text start plus every heading line.
  // The piece before the first heading (a preamble) is a section of its own.
  const boundaries: number[] = [0];
  for (const match of text.matchAll(HEADING_BOUNDARY)) {
    if (match.index !== undefined && match.index > 0) boundaries.push(match.index);
  }
  boundaries.push(text.length);

  const pieces: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end > start) pieces.push(...splitOversized(text, start, end));
  }

  const taken = pieces.slice(0, ZETTEL_MAX_SECTIONS);
  const sections = taken.map(({ start, end }) => ({ text: text.slice(start, end), start, end }));
  const readChars = taken.reduce((n, s) => n + (s.end - s.start), 0);
  return {
    sections,
    readChars,
    unreadChars: text.length - readChars,
    unreadSections: pieces.length - taken.length,
  };
}
