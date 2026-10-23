import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/workspace/ui";
import { getNote, listNoteBacklinks, listNoteOutlinks, listNoteTags, listNoteVersions, pageNotes, type NoteContent } from "@/domains/knowledge/notes";
import { relatedNotes } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { NewNoteButton, NoteEditor } from "./note-editor";
import { NotebookWorkspace } from "./notebook-workspace";
import { SearchResults, type SearchScope } from "./search-results";
import { SEARCH_KINDS } from "@/domains/knowledge/retrieval";

export const metadata = { title: "Notes · Polymath" };

/*
 * Notes on the canonical artifact rows (ASH-141 / B04): the list, autosaving
 * editor, checkpoints, history and draft recovery all read and write the same
 * artifact tables generated work uses. The /alfred/notebook URL and the
 * /apps/alfred notebook screen redirect here — one surface, one source of
 * truth.
 *
 * The page is the note: a slim collapsible list on the left, the note in one
 * centered column, and its properties, links and history behind the Note
 * details inspector (DESIGN.md § Minimalism).
 */

export function noteMarkdown(content: NoteContent | null): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return "";
}

// Per-request data; streams inside the Suspense boundary in the default export.
const BASE = "/alfred/notes";

export async function NotesSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await connection();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const id = typeof raw.id === "string" ? raw.id : undefined;
  // The list is a narrow sidebar: a short page keeps it scannable.
  const list = parseListParams(raw, {
    filters: { view: ["drafts"], layout: ["kanban"], kind: [...SEARCH_KINDS], edited: ["day", "week", "month"], source: ["agent", "not-agent"] },
    defaultPageSize: 10,
  });
  // Search-only scope: kind narrows the searched kinds, edited is a rolling
  // window on the same updated_at each hit row shows (absolute instant, no
  // calendar-day ambiguity), source is generation provenance exactly -
  // "agent" means produced_by_run_id set, never a human-authorship claim.
  const EDITED_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };
  const editedDays = list.filters.edited ? EDITED_DAYS[list.filters.edited] : undefined;
  // eslint-disable-next-line react-hooks/purity -- per-request rolling window: connection() above already opted this render out of prerendering, and the window must be evaluated at request time, not build time.
  const editedFrom = editedDays ? new Date(Date.now() - editedDays * 86_400_000) : undefined;
   
  const searchScope: SearchScope | undefined = list.q
    ? {
        kinds: list.filters.kind ? [list.filters.kind] : undefined,
        filters:
          editedDays || list.filters.source
            ? {
                ...(editedFrom ? { from: editedFrom } : {}),
                ...(list.filters.source ? { provenance: list.filters.source as "agent" | "not-agent" } : {}),
              }
            : undefined,
      }
    : undefined;
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

  const noteList = (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-[13px] font-medium">Notes</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {list.q && !kanban ? "Ranked by keyword and meaning" : `${found.total} ${list.q || list.filters.view ? "matching" : "in this workspace"}`}
        </p>
      </div>
      <ListToolbar
        searchPlaceholder="Search notes"
        filters={[
          { key: "view", label: "Show", allLabel: "All notes", options: [{ value: "drafts", label: "With unsaved draft" }] },
          { key: "layout", label: "Layout", allLabel: "List", options: [{ value: "kanban", label: "Kanban by tag" }] },
          // Search filters render only while a query is active: they filter
          // results, not the plain list, and an inert control would lie.
          ...(list.q
            ? [
                { key: "kind", label: "Kind", allLabel: "All kinds", options: SEARCH_KINDS.map((k) => ({ value: k as string, label: k === "transcript" ? "Conversation" : k[0].toUpperCase() + k.slice(1) })) },
                { key: "edited", label: "Edited", allLabel: "Any time", options: [{ value: "day", label: "Last 24 hours" }, { value: "week", label: "Last 7 days" }, { value: "month", label: "Last 30 days" }] },
                { key: "source", label: "Provenance", allLabel: "Any provenance", options: [{ value: "agent", label: "Agent-generated" }, { value: "not-agent", label: "Not agent-generated" }] },
              ]
            : []),
        ]}
      />
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Filter by tag">
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
      {list.q && !kanban ? (
        <SearchResults auth={auth} q={list.q} scope={searchScope} selectedId={selected?.id} hrefFor={(hitId) => listHref(BASE, raw, { id: hitId })} />
      ) : notes.length === 0 ? (
        <NoResults
          filtered={Boolean(list.q || list.filters.view)}
          clearHref={listHref(BASE, raw, { q: undefined, view: undefined, page: undefined })}
          emptyTitle="Write your first page."
          emptyDescription="It autosaves as you type, and every checkpoint becomes an immutable version."
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
    </div>
  );

  return (
    <div className="suite-screen">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-[13px] font-medium text-muted-foreground">Notes</h1>
        {selected && <NewNoteButton />}
      </header>
      <NotebookWorkspace list={noteList}>
        {selected ? (
          <NoteEditor
            key={selected.id}
            noteId={selected.id}
            initialTitle={selected.title}
            initialVersion={selected.version}
            initialMarkdown={noteMarkdown(selected.draft?.content ?? selected.content)}
            kind={selected.kind}
            tags={selected.tags}
            createdAt={selected.createdAt.toISOString()}
            updatedAt={selected.updatedAt.toISOString()}
            savedAt={(selected.draft?.updatedAt ?? selected.updatedAt).toISOString()}
            versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
            outlinks={outlinks}
            backlinks={backlinks}
            related={related}
          />
        ) : found.total === 0 ? (
          <div className="mx-auto max-w-[720px] px-3 py-12">
            <h2 className="text-lg" style={{ fontFamily: "var(--font-display)" }}>Write your first page.</h2>
            <p className="mt-2 text-[13px] text-muted-foreground">It autosaves as you type, and every checkpoint becomes an immutable version.</p>
            <div className="mt-5"><NewNoteButton /></div>
          </div>
        ) : (
          <div className="mx-auto max-w-[720px] px-3 py-12">
            <h2 className="text-lg" style={{ fontFamily: "var(--font-display)" }}>No note selected</h2>
            <div className="mt-5"><NewNoteButton /></div>
          </div>
        )}
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
  return (
    <div role="status" aria-label="Loading Notes" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
