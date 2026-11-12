import { io } from "next/cache";
import { z } from "zod";
import {
  extractWikiLinkTitles,
  getLinkPreviews,
  getNote,
  listNoteBacklinks,
  listNotes,
  type NoteListItem,
} from "@/domains/knowledge/notes";
import { noteContentToMarkdown } from "@/domains/knowledge/note-content";
import { markdownToPlainText } from "@/lib/display-text";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { NoteStack, type StackIndexEntry, type StackNote } from "./note-stack";

/*
 * The evergreen reading view, restored as an opt-in (?view=stack) beside the
 * single-page editor: each note opens as a pane to the right of the one that
 * linked to it, earlier panes fold into spines, and every pane ends with the
 * notes that link to it. The open trail lives in the URL (?stack=id,id,...) so
 * it can be shared, reloaded and walked back with the browser. The editor
 * stays the default view; this one is read-only.
 */

const MAX_PANES = 8;
const uuid = z.string().uuid();

function parseStack(raw: RawSearchParams): string[] {
  const value = typeof raw.stack === "string" ? raw.stack : "";
  const ids = value.split(",").filter((id) => uuid.safeParse(id).success);
  return [...new Set(ids)].slice(-MAX_PANES);
}

/** True when the URL asks for the stacked reader. A bare ?stack= is a retired
 * editor param and keeps opening its last note in the editor. */
export function wantsStackView(raw: RawSearchParams): boolean {
  return raw.view === "stack";
}

export async function NoteStackSurface({ raw, startId }: { raw: RawSearchParams; startId?: string }) {
  await io();
  const auth = await getAuthContext();
  const board = raw.board === "1";
  const requested = parseStack(raw);
  // Reading comes first: with no trail in the URL, the note the page already
  // opened (or the most recently tended one with words) is the first pane.
  const stack = requested.length ? requested : startId ? [startId] : [];

  const [all, opened] = await Promise.all([
    listNotes(auth, 2000),
    // Note and backlinks per pane in one wave: backlinks depend only on the id.
    Promise.all(
      stack.map(async (id) => {
        const [note, backlinks] = await Promise.all([getNote(auth, id), listNoteBacklinks(auth, id)]);
        return note ? { note, backlinks } : null;
      }),
    ),
  ]);

  const toEntry = (n: NoteListItem): StackIndexEntry => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : [],
    updatedAt: n.updatedAt.toISOString(),
    excerpt: n.excerpt ? markdownToPlainText(n.excerpt).slice(0, 280) : null,
  });
  const index = all.map(toEntry);

  // A board render shows the index only, so the notes are never built for it.
  const notes: StackNote[] = board
    ? []
    : opened
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .map(({ note, backlinks }) => ({
          id: note.id,
          title: note.title,
          kind: note.kind,
          tags: note.tags,
          updatedAt: note.updatedAt.toISOString(),
          markdown: noteContentToMarkdown(note.draft?.content ?? note.content),
          backlinks: backlinks.map((b) => ({
            id: b.id,
            title: b.title,
            snippet: b.context ? markdownToPlainText(b.context) : b.excerpt ? markdownToPlainText(b.excerpt) : null,
          })),
        }));

  // The index is capped, so a [[Title]] in an open pane may point past it:
  // those titles are looked up directly, and a link never reads as a missing
  // note just because the workspace is large.
  const indexed = new Set(index.map((entry) => entry.title.trim().toLowerCase()));
  const beyond = notes
    .flatMap((note) => extractWikiLinkTitles(note.markdown))
    .map((title) => title.split("|")[0].trim())
    .filter((title) => title && !indexed.has(title.toLowerCase()));
  const linked: StackIndexEntry[] = beyond.length
    ? (await getLinkPreviews(auth, beyond)).map((preview) => ({
        id: preview.id,
        title: preview.title,
        kind: "note",
        tags: [],
        updatedAt: new Date().toISOString(),
        excerpt: preview.firstParagraph || null,
      }))
    : [];

  return <NoteStack index={index} notes={notes} linked={linked} />;
}
