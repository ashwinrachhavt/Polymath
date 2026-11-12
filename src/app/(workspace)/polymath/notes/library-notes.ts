import { markdownToPlainText } from "@/lib/display-text";
import type { NoteListItem } from "@/domains/knowledge/notes";

/*
 * The Notes library rail: one row per note, carrying only what the rail
 * shows. Kept in a plain module (no "use client") because the server page,
 * the browse action and the client rail all speak this shape; a type imported
 * from a client module would not be readable by the two server callers.
 */

export type LibraryNote = {
  id: string;
  title: string;
  kind: string;
  /** One line of what the person last wrote, already stripped of Markdown. */
  excerpt: string | null;
  /** ISO instant; the rail formats it in the reader's own time zone. */
  updatedAt: string;
  hasDraft: boolean;
};

/** One page of the rail, and the most matches a search returns. */
export const LIBRARY_PAGE_SIZE = 30;

const EXCERPT_CHARS = 160;

/** Collapse Markdown to one short line: the rail previews, it does not render. */
export function plainExcerpt(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const text = markdownToPlainText(markdown).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, EXCERPT_CHARS) : null;
}

export function libraryNote(row: NoteListItem): LibraryNote {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    excerpt: plainExcerpt(row.excerpt),
    updatedAt: row.updatedAt.toISOString(),
    hasDraft: row.hasDraft,
  };
}
