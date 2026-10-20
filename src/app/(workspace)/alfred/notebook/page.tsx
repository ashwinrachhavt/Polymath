import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getNote, listNoteBacklinks, listNoteOutlinks, listNoteVersions, pageNotes, type NoteContent } from "@/domains/knowledge/notes";
import { relatedNotes } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { NewNoteButton, NoteEditor } from "./note-editor";

export const metadata = { title: "Notebook · Polymath" };

/*
 * The notebook on the canonical artifact rows (ASH-141 / B04): the list,
 * autosaving editor, checkpoints, history and draft recovery all read and
 * write the same artifact tables generated work uses. The /apps/alfred
 * notebook screen redirects here — one surface, one source of truth.
 */

export function noteMarkdown(content: NoteContent | null): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return "";
}

// Per-request data; streams inside the Suspense boundary in the default export.
const BASE = "/alfred/notebook";

export async function NotebookSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await connection();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const id = typeof raw.id === "string" ? raw.id : undefined;
  // The list is a narrow sidebar: a short page keeps it scannable.
  const list = parseListParams(raw, { filters: { view: ["drafts"] }, defaultPageSize: 10 });
  const found = await pageNotes(auth, {
    query: list.q,
    draftsOnly: list.filters.view === "drafts",
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const notes = found.items;
  const selected = id ? await getNote(auth, id) : null;
  const versions = selected ? await listNoteVersions(auth, selected.id) : [];
  const outlinks = selected ? await listNoteOutlinks(auth, selected.id) : [];
  const backlinks = selected ? await listNoteBacklinks(auth, selected.id) : [];
  const related = selected ? await relatedNotes(auth, selected.id) : [];

  return (
    <Screen
      title="Notebook"
      description="Notes live on the same artifact rows as generated work — autosaved as you type, with checkpoints you can name and a history you can trust."
      actions={<NewNoteButton />}
    >
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Panel title="Notes" description={`${found.total} ${list.q || list.filters.view ? "matching" : "in this workspace"}`}>
          <div className="mb-3">
            <ListToolbar
              searchPlaceholder="Search notes"
              filters={[{ key: "view", label: "Show", allLabel: "All notes", options: [{ value: "drafts", label: "With unsaved draft" }] }]}
            />
          </div>
          {notes.length === 0 ? (
            <NoResults
              filtered={Boolean(list.q || list.filters.view)}
              clearHref={listHref(BASE, raw, { q: undefined, view: undefined, page: undefined })}
              emptyTitle="No notes yet"
              emptyDescription="Create the first note — it autosaves as you type, and every checkpoint becomes an immutable version."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {notes.map((note) => (
                <li key={note.id}>
                  <Link
                    href={listHref(BASE, raw, { id: note.id })}
                    className={`block rounded-md border px-3 py-2 text-[13px] ${selected?.id === note.id ? "border-foreground/30 bg-muted/60" : "border-transparent hover:bg-muted/40"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{note.title}</span>
                      <span className="flex items-center gap-1">
                        {note.kind === "zettel" && <Status>zettel</Status>}
                        {note.hasDraft && <Status>draft</Status>}
                      </span>
                    </span>
                    {note.excerpt && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{note.excerpt}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />
        </Panel>
        {selected ? (
          <NoteEditor
            key={selected.id}
            noteId={selected.id}
            initialTitle={selected.title}
            initialVersion={selected.version}
            initialMarkdown={noteMarkdown(selected.content)}
            draft={selected.draft ? { markdown: noteMarkdown(selected.draft.content), updatedAt: selected.draft.updatedAt.toISOString() } : null}
            versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
            outlinks={outlinks}
            backlinks={backlinks}
            related={related}
          />
        ) : (
          <Panel>
            <Empty title="Choose a note" description="Pick a note on the left, or start a new one. Editing begins the moment you type." />
          </Panel>
        )}
      </div>
    </Screen>
  );
}

export default function NotebookPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<NotebookSkeleton />}>
      <NotebookSurface {...props} />
    </Suspense>
  );
}

function NotebookSkeleton() {
  return (
    <div role="status" aria-label="Loading Notebook" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
