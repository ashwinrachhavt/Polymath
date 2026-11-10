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
  type NoteContent,
} from "@/domains/knowledge/notes";
import { noteContentToMarkdown } from "@/domains/knowledge/note-content";
import { linkPreviewKeys } from "@/domains/knowledge/link-preview-keys";
import { listNoteComments } from "@/domains/knowledge/note-comments";
import { relatedNotes } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { NewNoteButton, NoteEditor } from "./note-editor";
import { noteLayout } from "./note-layout";
import { FindNoteButton, NotebookWorkspace } from "./notebook-workspace";

export const metadata = { title: "Notes · Polymath" };

/*
 * Notes on the canonical artifact rows (ASH-141 / B04): the autosaving editor,
 * checkpoints, history and draft recovery all read and write the same artifact
 * tables generated work uses. The /polymath/notebook URL and the retired
 * /apps/polymath/notebook preview address redirect here.
 *
 * The page is one note, always editable, in one centered column. Bare
 * /polymath/notes renders the most recent note in place (a redirect from
 * inside the stream would render twice) and the client writes its id into the
 * URL. A retired ?stack=a,b opens its last note; the other old view params
 * (board, mode, layout, q ...) are accepted and ignored.
 */

export function noteMarkdown(content: NoteContent | null): string {
  return noteContentToMarkdown(content);
}

function requestedNoteId(raw: RawSearchParams): string | undefined {
  if (typeof raw.id === "string") return raw.id;
  if (typeof raw.stack === "string") return raw.stack.split(",").filter(Boolean).at(-1);
}

function NotesMessage({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className={noteLayout.screen}>
      <NotebookWorkspace>
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

  if (!id) {
    return (
      <NotesMessage
        title="Write your first page."
        body="It autosaves as you type, and every checkpoint becomes an immutable version."
      >
        <NewNoteButton />
      </NotesMessage>
    );
  }

  const selected = await getNote(auth, id);
  if (!selected) {
    return (
      <NotesMessage
        title="That note is not here"
        body="It may have been archived. Find another note, or start a new one."
      >
        <FindNoteButton />
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
      <NotebookWorkspace replaceUrl={raw.id === selected.id ? undefined : `/polymath/notes?id=${selected.id}`}>
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
  // wrapper, so the title and the first line hold still when the note arrives.
  return (
    <div role="status" aria-label="Loading Notes" className={noteLayout.screen}>
      <div className={noteLayout.row}>
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
