import { Suspense, type ReactNode } from "react";
import { io } from "next/cache";
import { z } from "zod";
import { Skeleton } from "@/components/ui/skeleton";
import {
  extractWikiLinkTitles,
  getLinkPreviews,
  getNote,
  listNoteBacklinks,
  listNoteOutlinks,
  listNotes,
  listNoteVersions,
  pageNotes,
  type NoteContent,
} from "@/domains/knowledge/notes";
import { noteContentToMarkdown } from "@/domains/knowledge/note-content";
import { linkPreviewKeys } from "@/domains/knowledge/link-preview-keys";
import { listNoteComments } from "@/domains/knowledge/note-comments";
import { markdownToPlainText } from "@/lib/display-text";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { NewNoteButton, NoteEditor } from "./note-editor";
import { noteLayout } from "./note-layout";
import { NoteStack, type NoteRef, type StackNote } from "./note-stack";
import { FindNoteButton, NotebookWorkspace } from "./notebook-workspace";
import { LISTED_KINDS, NOTES_LIST_SIZE, noteHistory } from "./notes-history";
import { NotesNav } from "./notes-nav";

export const metadata = { title: "Notes · Polymath" };

/*
 * Notes on the canonical artifact rows (ASH-141 / B04): the autosaving editor,
 * checkpoints, history and draft recovery all read and write the same artifact
 * tables generated work uses. The /polymath/notebook URL and the retired
 * /apps/polymath/notebook preview address redirect here.
 *
 * The page is one note, written in place, with the way to every other note in
 * a "Notes" popover at its top (built like the chat's "Chats"). A [[link]] or
 * backlink opens the linked note as a reading pane beside it: ?id= names the
 * note being written, ?stack= the panes open to its right. Bare /polymath/notes
 * renders the most recent note in place (a redirect from inside the stream
 * would render twice) and the client writes its id into the URL. Retired view
 * params (view, board, mode, layout, page, q ...) are accepted and ignored.
 */

export function noteMarkdown(content: NoteContent | null): string {
  return noteContentToMarkdown(content);
}

const MAX_PANES = 8;
const uuid = z.string().uuid();

/** The note being written and the panes open beside it. Without an `id`, the trail's first note is written. */
function requestedNotes(raw: RawSearchParams): { id: string | undefined; stack: string[] } {
  const trail = typeof raw.stack === "string" ? raw.stack.split(",").filter((id) => uuid.safeParse(id).success) : [];
  const id = typeof raw.id === "string" ? raw.id : trail[0];
  const stack = [...new Set(trail)].filter((pane) => pane !== id).slice(-MAX_PANES);
  return { id, stack };
}

const noteUrl = (id: string, stack: string[]) =>
  stack.length ? `/polymath/notes?id=${id}&stack=${stack.join(",")}` : `/polymath/notes?id=${id}`;

/** The linked notes open beside the written one, and the notes their own [[links]] name. */
async function loadPanes(auth: AuthContext, ids: string[]): Promise<{ notes: StackNote[]; linked: NoteRef[] }> {
  if (!ids.length) return { notes: [], linked: [] };
  // Note and backlinks per pane in one wave: backlinks depend only on the id.
  const opened = await Promise.all(
    ids.map(async (id) => {
      const [note, backlinks] = await Promise.all([getNote(auth, id), listNoteBacklinks(auth, id)]);
      return note ? { note, backlinks } : null;
    }),
  );
  const notes = opened
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(({ note, backlinks }): StackNote => ({
      id: note.id,
      title: note.title,
      kind: note.kind,
      tags: note.tags,
      updatedAt: note.updatedAt.toISOString(),
      markdown: noteMarkdown(note.draft?.content ?? note.content),
      backlinks: backlinks.map((b) => ({
        id: b.id,
        title: b.title,
        snippet: b.context ? markdownToPlainText(b.context) : b.excerpt ? markdownToPlainText(b.excerpt) : null,
      })),
    }));
  const titles = notes
    .flatMap((note) => extractWikiLinkTitles(note.markdown))
    .map((title) => title.split("|")[0].trim())
    .filter(Boolean);
  const linked = titles.length
    ? (await getLinkPreviews(auth, titles)).map((preview) => ({
        id: preview.id,
        title: preview.title,
        excerpt: preview.firstParagraph || null,
      }))
    : [];
  return { notes, linked };
}

function NotesMessage({
  title,
  body,
  nav,
  children,
}: {
  title: string;
  body: string;
  nav: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${noteLayout.screen} overflow-y-auto`}>
      <NotebookWorkspace>
        <div className={noteLayout.bar}>{nav}</div>
        <div className="mx-auto w-full max-w-[var(--measure-prose)] px-6 pb-16 pt-12">
          <h1 className="text-lg" style={{ fontFamily: "var(--font-display)" }}>
            {title}
          </h1>
          <p className="mt-2 text-body-dense text-muted-foreground">{body}</p>
          <div className="mt-5 flex items-center gap-2">{children}</div>
        </div>
      </NotebookWorkspace>
    </div>
  );
}

// Per-request data; streams inside the Suspense boundary in the default export.
export async function NotesSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const requested = requestedNotes(raw);
  let id = requested.id;
  if (!id) {
    const recent = await listNotes(auth, 25, ["note"]);
    id = (recent.find((note) => note.excerpt?.trim()) ?? recent[0])?.id;
  }

  // The list, the written note and the panes beside it are independent reads.
  const [listed, selected, panes] = await Promise.all([
    pageNotes(auth, { kinds: LISTED_KINDS, limit: NOTES_LIST_SIZE, offset: 0 }),
    id ? getNote(auth, id) : Promise.resolve(null),
    loadPanes(auth, requested.stack),
  ]);
  const nav = <NotesNav groups={noteHistory(listed.items)} currentId={selected?.id} />;

  if (!selected) {
    return id ? (
      <NotesMessage
        title="That note is not here"
        body="It may have been archived. Find another note, or start a new one."
        nav={nav}
      >
        <FindNoteButton />
        <NewNoteButton />
      </NotesMessage>
    ) : (
      <NotesMessage
        title="Write your first page."
        body="It autosaves as you type, and every checkpoint becomes an immutable version."
        nav={nav}
      >
        <NewNoteButton />
      </NotesMessage>
    );
  }

  // The inspector's versions, links and margin comments all key off the same
  // note and do not depend on each other.
  // Titles come from the markdown the editor opens with; an alias after "|" is display text.
  const linkedTitles = extractWikiLinkTitles(noteMarkdown(selected.draft?.content ?? selected.content)).map((t) =>
    t.split("|")[0].trim(),
  );
  const [versions, outlinks, backlinks, comments, linkedPreviews] = await Promise.all([
    listNoteVersions(auth, selected.id),
    listNoteOutlinks(auth, selected.id),
    listNoteBacklinks(auth, selected.id),
    listNoteComments(auth, selected.id).catch(() => []),
    getLinkPreviews(auth, linkedTitles),
  ]);

  // A linked title is missing only if this render looked it up (the lookup is
  // capped) and found no note. Links added later, titles past the cap, and a
  // link to this note itself read as ordinary links.
  const ownTitle = selected.title.trim().toLowerCase();
  const previewed = new Set(linkedPreviews.map((p) => p.title.trim().toLowerCase()));
  const missingLinkTitles = linkPreviewKeys(linkedTitles).filter((key) => key !== ownTitle && !previewed.has(key));
  const paneIds = panes.notes.map((note) => note.id);

  return (
    <div className={noteLayout.screen}>
      <NotebookWorkspace replaceUrl={raw.id === selected.id ? undefined : noteUrl(selected.id, paneIds)}>
        <NoteStack
          noteId={selected.id}
          noteTitle={selected.title}
          notes={panes.notes}
          // The written note is a link target from the panes too: it scrolls back into view.
          linked={[...panes.linked, { id: selected.id, title: selected.title, excerpt: null }]}
          editor={
            <NoteEditor
              key={selected.id}
              noteId={selected.id}
              nav={nav}
              indexNotice={
                selected.indexed || !selected.currentVersionId
                  ? null
                  : selected.embedError
                    ? { kind: "failed" as const, error: selected.embedError }
                    : { kind: "unindexed" as const }
              }
              initialTitle={selected.title}
              initialVersion={selected.version}
              initialMarkdown={noteMarkdown(selected.draft?.content ?? selected.content)}
              kind={selected.kind}
              tags={selected.tags}
              createdAt={selected.createdAt.toISOString()}
              updatedAt={selected.updatedAt.toISOString()}
              savedAt={(selected.draft?.updatedAt ?? selected.updatedAt).toISOString()}
              versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
              linkedPreviews={linkedPreviews.filter((p) => p.id !== selected.id)}
              missingLinkTitles={missingLinkTitles}
              outlinks={outlinks}
              backlinks={backlinks}
              comments={comments.map((c) => ({
                id: c.id,
                body: c.body,
                resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
                createdAt: c.createdAt.toISOString(),
                authorName: c.authorName,
              }))}
            />
          }
        />
      </NotebookWorkspace>
    </div>
  );
}

export default function NotesPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<NotesSkeleton />}>
      <NotesSurface {...props} />
    </Suspense>
  );
}

function NotesSkeleton() {
  // Built from the loaded note's layout classes (note-layout.ts), wrapper for
  // wrapper, so the bar, the title and the first line hold still when the
  // note arrives.
  return (
    <div role="status" aria-label="Loading Notes" className={noteLayout.screen}>
      <div className={noteLayout.bar}>
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-24" />
      </div>
      <div className={noteLayout.column}>
        <Skeleton data-skeleton-title className={`${noteLayout.titleText} h-[1.2em] w-2/3`} />
        <div className={noteLayout.meta}>
          <Skeleton className="h-3 w-28" />
        </div>
        <div data-skeleton-body className={`${noteLayout.body} gap-6`}>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-[94%]" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-[72%]" />
        </div>
      </div>
    </div>
  );
}
