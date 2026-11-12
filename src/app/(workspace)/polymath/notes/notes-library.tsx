"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { browseNotesAction } from "./actions";
import { DAY_MS, startOfLocalDay } from "@/lib/history-groups";
import { LIBRARY_PAGE_SIZE, type LibraryNote } from "./library-notes";
import { NewNoteButton } from "./note-editor";

/*
 * The Notes library rail: every note this workspace holds, newest first, with
 * the one that is open marked. It is a rail of durable artifacts, not a review
 * queue - a note leaves this list only when it is archived.
 *
 * The first page arrives server-rendered with the note, so opening a note
 * costs no extra client fetch. Search is the exception: typing narrows the
 * list through the browse action (the same paged keyword query the page uses)
 * and never navigates, so filtering cannot close the note being read. Paging
 * is ordinary links, so older notes stay reachable without JavaScript and the
 * URL says which page is shown.
 */

const SEARCH_DEBOUNCE_MS = 150;

type Answer = { query: string; items: LibraryNote[]; total: number };

/** Days from today, DST-safe (23/25-hour days round to one). */
function daysAgo(iso: string): number {
  const today = startOfLocalDay(new Date());
  return Math.round((today - startOfLocalDay(new Date(iso))) / DAY_MS);
}

/** The row's stamp: a time for today, a date for anything older. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (daysAgo(iso) === 0) return date.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** Consecutive rows share a day because the query is newest-first. */
function groupByDay(rows: LibraryNote[]): { key: string; label: string; rows: LibraryNote[] }[] {
  const groups: { key: string; label: string; rows: LibraryNote[] }[] = [];
  for (const row of rows) {
    const days = daysAgo(row.updatedAt);
    const day = new Date(row.updatedAt);
    const key =
      days === 0 ? "today" : days === 1 ? "yesterday" : `d-${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    const label =
      days === 0
        ? "Today"
        : days === 1
          ? "Yesterday"
          : day.toLocaleDateString("en", { month: "short", day: "numeric" });
    const last = groups.at(-1);
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, label, rows: [row] });
  }
  return groups;
}

function noteHref(id: string, page: number): string {
  const params = new URLSearchParams({ id });
  if (page > 1) params.set("page", String(page));
  return `/polymath/notes?${params.toString()}`;
}

function pageHref(id: string | null, page: number): string {
  const params = new URLSearchParams();
  if (id) params.set("id", id);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/polymath/notes?${query}` : "/polymath/notes";
}

export function NotesLibrary({
  notes,
  selectedId,
  total,
  page,
}: {
  notes: LibraryNote[];
  selectedId: string | null;
  total: number;
  page: number;
}) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);

  const trimmed = query.trim();
  const answered = answer?.query === trimmed ? answer : null;
  const searching = trimmed !== "" && answered === null;

  useEffect(() => {
    if (!trimmed) return;
    const ticket = ++request.current;
    const timer = window.setTimeout(() => {
      browseNotesAction({ query: trimmed })
        .then((found) => {
          if (ticket !== request.current) return;
          setAnswer({ query: trimmed, items: found.items, total: found.total });
          setFailed(false);
        })
        .catch(() => {
          if (ticket === request.current) setFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed]);

  // An emptied field goes back to the page the server already rendered; a
  // stored answer is ignored rather than refetched for the same query.
  const rows = trimmed ? (answered?.items ?? []) : notes;
  const shown = trimmed ? (answered?.total ?? 0) : total;
  const pageCount = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE));

  return (
    <div className="flex h-full flex-col gap-3 px-3 py-4" data-notes-library>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <h2 className="text-body-dense font-medium">
          Notes <span className="font-normal text-muted-foreground">{total}</span>
        </h2>
        <NewNoteButton icon />
      </div>

      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 pl-8 text-body-dense"
        />
      </div>

      {searching ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          Searching…
        </p>
      ) : failed ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          Search is unavailable. Keep typing to try again.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          {trimmed
            ? `No notes match “${trimmed}”.`
            : total > 0
              ? "No notes on this page."
              : "No notes yet. Write the first one."}
        </p>
      ) : (
        /*
         * One row per note, shaped like the /polymath conversation list: the
         * title on the left, the day on the right, grouped by day. It reads as
         * the same kind of list as chats so the two surfaces are learned once.
         */
        <div aria-label="Your notes" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {groupByDay(rows).map((group) => (
            <section key={group.key} aria-label={group.label}>
              <p className="text-muted-foreground px-2 pb-1 text-label font-medium">{group.label}</p>
              <ul>
                {group.rows.map((note) => {
                  const selected = note.id === selectedId;
                  return (
                    <li key={note.id}>
                      <Link
                        href={noteHref(note.id, 1)}
                        aria-current={selected ? "page" : undefined}
                        className={cn(
                          "flex h-9 items-center gap-3 rounded-md px-2 text-body-dense outline-none transition-colors",
                          "focus-visible:ring-2 focus-visible:ring-ring",
                          selected ? "bg-muted text-foreground" : "hover:bg-muted/70",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {note.title.trim() || "Untitled note"}
                          {note.kind === "zettel" ? (
                            <span className="text-muted-foreground ml-2 text-[10px] uppercase tracking-wide">
                              zettel
                            </span>
                          ) : null}
                          {note.hasDraft && !selected ? (
                            <span className="text-muted-foreground ml-2 text-[10px] uppercase tracking-wide">
                              draft
                            </span>
                          ) : null}
                        </span>
                        <span
                          className="text-muted-foreground shrink-0 text-data tabular-nums"
                          suppressHydrationWarning
                        >
                          {dayLabel(note.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!trimmed && pageCount > 1 ? (
        <nav aria-label="Note pages" className="flex items-center justify-between gap-2 px-0.5">
          {page > 1 ? (
            <Button asChild variant="ghost" size="xs" className="text-muted-foreground">
              <Link href={pageHref(selectedId, page - 1)}>Newer</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-[11px] text-muted-foreground">
            {page} / {pageCount}
          </span>
          {page < pageCount ? (
            <Button asChild variant="ghost" size="xs" className="text-muted-foreground">
              <Link href={pageHref(selectedId, page + 1)}>Older</Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      {trimmed && answered && answered.total > answered.items.length ? (
        <p className="px-1 text-[11px] text-muted-foreground">
          Showing {answered.items.length} of {shown}. Refine the search to narrow it.
        </p>
      ) : null}
    </div>
  );
}
