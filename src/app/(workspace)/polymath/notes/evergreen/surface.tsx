import { io } from "next/cache";
import { z } from "zod";
import {
  extractWikiLinkTitles,
  findNotesByTitle,
  getNote,
  listNoteBacklinks,
  listNotes,
  type NoteListItem,
} from "@/domains/knowledge/notes";
import { noteContentToMarkdown } from "@/domains/knowledge/note-content";
import { markdownToPlainText } from "@/lib/display-text";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { EvergreenStack, type StackIndexEntry, type StackNote } from "./evergreen-stack";

/*
 * A read-only view of the notes graph in the evergreen-notes style: each note
 * opens as a pane to the right of the one that linked to it, earlier panes
 * fold into spines, and every pane ends with the notes that link to it. The
 * open trail lives in the URL (?stack=id,id,...) so it can be shared, reloaded
 * and walked back with the browser. Editing stays on /polymath/notes.
 */

const MAX_PANES = 8;
const uuid = z.string().uuid();

function parseStack(raw: RawSearchParams): string[] {
  const value = typeof raw.stack === "string" ? raw.stack : "";
  const ids = value.split(",").filter((id) => uuid.safeParse(id).success);
  return [...new Set(ids)].slice(-MAX_PANES);
}

export async function EvergreenSurface({ raw }: { raw: RawSearchParams }) {
  await io();
  const auth = await getAuthContext();
  const board = raw.board === "1";
  const requested = parseStack(raw);
  // Reading comes first: with no trail in the URL, the most recently tended
  // note with words in it opens beside the index instead of a board of cards.
  // An empty draft is not worth opening to; prefer the latest note with words in it.
  const recent = requested.length || board ? [] : await listNotes(auth, 25);
  const latest = recent.find((note) => note.excerpt?.trim()) ?? recent[0];
  const stack = latest ? [latest.id] : requested;

  const [all, opened] = await Promise.all([
    listNotes(auth, 2000),
    Promise.all(
      stack.map(async (id) => {
        const note = await getNote(auth, id);
        if (!note) return null;
        const backlinks = await listNoteBacklinks(auth, id);
        return { note, backlinks };
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

  const notes: StackNote[] = opened
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
  const linked = beyond.length ? (await findNotesByTitle(auth, beyond)).map(toEntry) : [];

  return <EvergreenStack index={index} notes={board ? [] : notes} linked={linked} />;
}
