import { Suspense, type ReactNode } from "react";
import { io } from "next/cache";
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
import { relatedNotes } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { LIBRARY_PAGE_SIZE, libraryNote, plainExcerpt } from "./library-notes";
import { NewNoteButton, NoteEditor } from "./note-editor";
import { noteLayout } from "./note-layout";
import { FindNoteButton, NotebookWorkspace } from "./notebook-workspace";
import { NotesLibrary } from "./notes-library";

export const metadata = { title: "Notes · Polymath" };

/*
 * Notes on the canonical artifact rows (ASH-141 / B04): the autosaving editor,
 * checkpoints, history and draft recovery all read and write the same artifact
 * tables generated work uses. The /polymath/notebook URL and the retired
 * /apps/polymath/notebook preview address redirect here.
 *
 * The page is a library rail beside one note, always editable, in one centered
 * column. The rail lists every note the workspace holds, newest first, one
 * page at a time (`?page=2`), with the open note marked: finishing a note must
 * never be the reason it disappears. Bare /polymath/notes renders the most
 * recent note in place (a redirect from inside the stream would render twice)
 * and the client writes its id into the URL. A retired ?stack=a,b opens its
 * last note; the other old view params (board, mode, layout, q ...) are
 * accepted and ignored.
 */

export function noteMarkdown(content: NoteContent | null): string {
  return noteContentToMarkdown(content);
}

function requestedNoteId(raw: RawSearchParams): string | undefined {
  if (typeof raw.id === "string") return raw.id;
  if (typeof raw.stack === "string") return raw.stack.split(",").filter(Boolean).at(-1);
}

/** The rail's page; a malformed or absurd value reads as the first page. */
function requestedPage(raw: RawSearchParams): number {
  const value = typeof raw.page === "string" ? Number(raw.page) : 1;
  return Number.isInteger(value) && value > 1 ? Math.min(value, 500) : 1;
}

function NotesMessage({
  title,
  body,
  library,
  children,
}: {
  title: string;
  body: string;
  library?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={noteLayout.screen}>
      <NotebookWorkspace library={library}>
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
  let id = requestedNoteId(raw);
  if (!id) {
    const recent = await listNotes(auth, 25, ["note"]);
    id = (recent.find((note) => note.excerpt?.trim()) ?? recent[0])?.id;
  }

  // The rail's page and the open note are independent reads.
  const page = requestedPage(raw);
  const [found, selected] = await Promise.all([
    pageNotes(auth, { limit: LIBRARY_PAGE_SIZE, offset: (page - 1) * LIBRARY_PAGE_SIZE }),
    id ? getNote(auth, id) : Promise.resolve(null),
  ]);

  const rows = found.items.map(libraryNote);
  // A note opened from a bookmark can be older than the rail's page; it still
  // belongs in the list, marked, instead of vanishing from the library.
  if (selected && !rows.some((row) => row.id === selected.id)) {
    rows.unshift({
      id: selected.id,
      title: selected.title,
      kind: selected.kind,
      excerpt: plainExcerpt(noteMarkdown(selected.draft?.content ?? selected.content)),
      updatedAt: selected.updatedAt.toISOString(),
      hasDraft: selected.draft !== null,
    });
  }
  const library =
    found.total > 0 ? (
      <NotesLibrary notes={rows} selectedId={selected?.id ?? null} total={found.total} page={page} />
    ) : undefined;

  if (!selected) {
    return id ? (
      <NotesMessage
        title="That note is not here"
        body="It may have been archived. Find another note, or start a new one."
        library={library}
      >
        <FindNoteButton />
        <NewNoteButton />
      </NotesMessage>
    ) : (
      <NotesMessage
        title="Write your first page."
        body="It autosaves as you type, and every checkpoint becomes an immutable version."
      >
        <NewNoteButton />
      </NotesMessage>
    );
  }

  // The inspector's versions, links, related notes and margin comments all
  // key off the same note and do not depend on each other.
  // Titles come from the markdown the editor opens with; an alias after "|" is display text.
  const linkedTitles = extractWikiLinkTitles(noteMarkdown(selected.draft?.content ?? selected.content)).map((t) =>
    t.split("|")[0].trim(),
  );
  const [versions, outlinks, backlinks, related, comments, linkedPreviews] = await Promise.all([
    listNoteVersions(auth, selected.id),
    listNoteOutlinks(auth, selected.id),
    listNoteBacklinks(auth, selected.id),
    relatedNotes(auth, selected.id),
    listNoteComments(auth, selected.id).catch(() => []),
    getLinkPreviews(auth, linkedTitles),
  ]);

  // A linked title is missing only if this render looked it up (the lookup is
  // capped) and found no note. Links added later, titles past the cap, and a
  // link to this note itself read as ordinary links.
  const ownTitle = selected.title.trim().toLowerCase();
  const previewed = new Set(linkedPreviews.map((p) => p.title.trim().toLowerCase()));
  const missingLinkTitles = linkPreviewKeys(linkedTitles).filter((key) => key !== ownTitle && !previewed.has(key));

  return (
    <div className={noteLayout.screen}>
      <NotebookWorkspace
        library={library}
        replaceUrl={raw.id === selected.id ? undefined : `/polymath/notes?id=${selected.id}`}
      >
        <NoteEditor
          key={selected.id}
          noteId={selected.id}
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
          related={related}
          comments={comments.map((c) => ({
            id: c.id,
            body: c.body,
            resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
            createdAt: c.createdAt.toISOString(),
            authorName: c.authorName,
          }))}
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
  // wrapper, so the rail, the title and the first line hold still when the
  // note arrives.
  return (
    <div role="status" aria-label="Loading Notes" className={noteLayout.screen}>
      <div className={noteLayout.row}>
        {/* The library rail's width is the note column's neighbour. */}
        <div aria-hidden className="sticky top-0 hidden shrink-0 lg:block">
          <div className="flex w-64 flex-col gap-3 px-3 py-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-2.5 py-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        </div>
        <div className={noteLayout.cell}>
          <div className={noteLayout.row}>
            {/* The container query that places the column in margin mode keys off this. */}
            <div data-note-container className={noteLayout.cell}>
              <div className={noteLayout.column}>
                {/* The header's four icon actions sit at the right. */}
                <div className={noteLayout.header}>
                  <Skeleton className="h-7 w-31" />
                </div>
                <div className={noteLayout.titleRow}>
                  <Skeleton data-skeleton-title className={`${noteLayout.titleText} h-[1.2em] w-2/3`} />
                </div>
                <div className={noteLayout.meta}>
                  <Skeleton className="h-3 w-28" />
                </div>
                {/* The quiet action row: three xs buttons (h-6) about as wide as
                    the loaded ones, so a phone wraps them the same way. */}
                <div className={noteLayout.actions}>
                  <Skeleton className="h-6 w-24" />
                  <Skeleton className="h-6 w-28" />
                  <Skeleton className="h-6 w-24" />
                </div>
                <div data-skeleton-body className={`${noteLayout.body} gap-6`}>
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-[94%]" />
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-[72%]" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
