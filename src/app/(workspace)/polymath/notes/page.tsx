import { redirect } from "next/navigation";
import { Suspense } from "react";
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
import { listNoteComments } from "@/domains/knowledge/note-comments";
import { relatedNotes } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { NewNoteButton, NoteEditor } from "./note-editor";
import { NotebookWorkspace } from "./notebook-workspace";

export const metadata = { title: "Notes · Polymath" };

/*
 * Notes on the canonical artifact rows (ASH-141 / B04): the autosaving editor,
 * checkpoints, history and draft recovery all read and write the same artifact
 * tables generated work uses. The /polymath/notebook URL and the
 * /apps/polymath notebook screen redirect here.
 *
 * The page is one note, always editable, in one centered column. Bare
 * /polymath/notes opens the most recent note; Cmd+K finds any other. The old
 * view params (board, mode, stack, layout, q ...) are accepted and ignored.
 */

export function noteMarkdown(content: NoteContent | null): string {
  return noteContentToMarkdown(content);
}

// Per-request data; streams inside the Suspense boundary in the default export.
export async function NotesSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const id = typeof raw.id === "string" ? raw.id : undefined;

  if (!id) {
    const recent = await listNotes(auth, 25);
    const latest = recent.find((note) => note.excerpt?.trim()) ?? recent[0];
    if (latest) redirect(`/polymath/notes?id=${latest.id}`);
    return (
      <div className="suite-screen h-full overflow-y-auto">
        <NotebookWorkspace>
          <div className="mx-auto w-full max-w-[var(--measure-prose)] px-6 pb-16 pt-12">
            <h1 className="text-lg" style={{ fontFamily: "var(--font-display)" }}>
              Write your first page.
            </h1>
            <p className="mt-2 text-body-dense text-muted-foreground">
              It autosaves as you type, and every checkpoint becomes an immutable version.
            </p>
            <div className="mt-5">
              <NewNoteButton />
            </div>
          </div>
        </NotebookWorkspace>
      </div>
    );
  }

  const selected = await getNote(auth, id);
  if (!selected) {
    return (
      <div className="suite-screen h-full overflow-y-auto">
        <NotebookWorkspace>
          <div className="mx-auto w-full max-w-[var(--measure-prose)] px-6 pb-16 pt-12">
            <h1 className="text-lg" style={{ fontFamily: "var(--font-display)" }}>
              That note is not here
            </h1>
            <p className="mt-2 text-body-dense text-muted-foreground">
              It may have been archived. Press Cmd+K to find another, or start a new one.
            </p>
            <div className="mt-5">
              <NewNoteButton />
            </div>
          </div>
        </NotebookWorkspace>
      </div>
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

  return (
    <div className="suite-screen h-full overflow-y-auto">
      <NotebookWorkspace>
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
  // Shape-matches the loaded workspace — the shared
  // --measure-prose reading column at the canvas offset — so the stream-in
  // never reflows the page it becomes.
  return (
    <div role="status" aria-label="Loading Notes" className="flex items-start gap-6">
      <div className="mx-auto w-full max-w-[var(--measure-prose)] flex-1 px-6 pt-12">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="mt-8 h-9 w-2/3" />
        <div className="mt-10 flex flex-col gap-6">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-[94%]" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-[72%]" />
        </div>
      </div>
    </div>
  );
}
