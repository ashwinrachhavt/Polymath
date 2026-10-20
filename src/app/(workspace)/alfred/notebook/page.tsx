import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getNote, listNoteBacklinks, listNoteOutlinks, listNoteTags, listNoteVersions, pageNotes, type NoteContent } from "@/domains/knowledge/notes";
import { relatedNotes } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { NewNoteButton, NoteEditor } from "./note-editor";
import { SearchResults } from "./search-results";

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
  const list = parseListParams(raw, { filters: { view: ["drafts"], layout: ["kanban"] }, defaultPageSize: 10 });
  const tag = typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim().toLowerCase() : undefined;
  const kanban = list.filters.layout === "kanban";
  const found = await pageNotes(auth, {
    query: list.q,
    draftsOnly: list.filters.view === "drafts",
    tag,
    // The kanban groups the whole matching set into columns, so it reads one wide page.
    limit: kanban ? 200 : list.pageSize,
    offset: kanban ? 0 : offsetFor(list.page, list.pageSize),
  });
  if (!kanban) redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const notes = found.items;
  const allTags = await listNoteTags(auth);
  const selected = id ? await getNote(auth, id) : null;
  const versions = selected ? await listNoteVersions(auth, selected.id) : [];
  const outlinks = selected ? await listNoteOutlinks(auth, selected.id) : [];
  const backlinks = selected ? await listNoteBacklinks(auth, selected.id) : [];
  const related = selected ? await relatedNotes(auth, selected.id) : [];

  return (
    <Screen
      title="Notebook"
      description="Notes autosave as you type, with checkpoints you can name."
      actions={<NewNoteButton />}
    >
      <div className={`grid gap-4 ${kanban ? "lg:grid-cols-[minmax(360px,480px)_1fr]" : "lg:grid-cols-[300px_1fr]"}`}>
        <Panel title="Notes" description={list.q && !kanban ? "Ranked by keyword and meaning" : `${found.total} ${list.q || list.filters.view ? "matching" : "in this workspace"}`}>
          <div className="mb-3">
            <ListToolbar
              searchPlaceholder="Search notes"
              filters={[
                { key: "view", label: "Show", allLabel: "All notes", options: [{ value: "drafts", label: "With unsaved draft" }] },
                { key: "layout", label: "Layout", allLabel: "List", options: [{ value: "kanban", label: "Kanban by tag" }] },
              ]
              }
            />
            {allTags.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1" aria-label="Filter by tag">
                {allTags.map((t) => (
                  <Link
                    key={t}
                    href={listHref(BASE, raw, { tag: tag === t ? undefined : t, page: undefined, id: undefined })}
                    aria-pressed={tag === t}
                    className={`rounded-full border px-2 py-0.5 text-xs ${tag === t ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40"}`}
                  >
                    {t}
                  </Link>
                ))}
              </div>
            )}
          </div>
          {list.q && !kanban ? (
            <SearchResults auth={auth} q={list.q} selectedId={selected?.id} hrefFor={(hitId) => listHref(BASE, raw, { id: hitId })} />
          ) : notes.length === 0 ? (
            <NoResults
              filtered={Boolean(list.q || list.filters.view)}
              clearHref={listHref(BASE, raw, { q: undefined, view: undefined, page: undefined })}
              emptyTitle="No notes yet"
              emptyDescription="Create the first note — it autosaves as you type, and every checkpoint becomes an immutable version."
            />
          ) : kanban ? (
            <div className="flex flex-col gap-3">
              {Object.entries(
                notes.reduce<Record<string, typeof notes>>((groups, note) => {
                  const column = note.tags[0] ?? "untagged";
                  (groups[column] ??= []).push(note);
                  return groups;
                }, {}),
              ).map(([column, columnNotes]) => (
                <section key={column} aria-label={`Tag ${column}`} className="rounded-md border border-border">
                  <header className="flex items-center justify-between border-b border-border px-3 py-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{column}</span>
                    <span className="text-xs text-muted-foreground">{columnNotes.length}</span>
                  </header>
                  <ul className="flex flex-col gap-1 p-1.5">
                    {columnNotes.map((note) => (
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
                </section>
              ))}
            </div>
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
          {!kanban && !list.q && <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />}
        </Panel>
        {selected ? (
          <NoteEditor
            key={selected.id}
            noteId={selected.id}
            initialTitle={selected.title}
            initialVersion={selected.version}
            initialMarkdown={noteMarkdown(selected.content)}
            kind={selected.kind}
            tags={selected.tags}
            createdAt={selected.createdAt.toISOString()}
            updatedAt={selected.updatedAt.toISOString()}
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
