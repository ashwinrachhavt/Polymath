"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, History, Search } from "lucide-react";
import type { HistoryGroup } from "./history";

export type { HistoryGroup };

/** The quiet chip the history trigger and its neighbours ("New chat", "New note") share. */
export const historyChipClass =
  "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-label whitespace-nowrap outline-none transition-colors focus-visible:ring-2";

const SEARCH_DEBOUNCE_MS = 150;

/*
 * The history chip. One control for every list of past work that sits above a
 * page: the conversations above a chat, the notes above a note. The page is
 * the content; the history stays one click away without taking any of its
 * width.
 *
 * Local state rather than Radix Popover: the rows are plain links, so there is
 * no list to rove with arrow keys and no selection to trap. Escape, outside
 * click, and navigation are three short effects and one click handler; a
 * portal would buy nothing.
 *
 * Rows are grouped and stamped on the server (see ./history), so the panel
 * never disagrees with another view of the same list about which day a row is
 * in. A searchable menu asks its `search` for already-grouped rows too; typing
 * never navigates, so narrowing the list cannot close the page being read.
 */
export function HistoryMenu({
  groups,
  label = "History",
  listLabel = "Chat history",
  empty = "No conversations yet.",
  currentId,
  search,
  className,
}: {
  groups: HistoryGroup[];
  label?: string;
  /** Names the list for assistive tech. */
  listLabel?: string;
  /** What the panel says when there is nothing to list. */
  empty?: string;
  /** The row for the page on screen, marked as current. */
  currentId?: string;
  /** Narrows the list by a query; answers with grouped rows like `groups`. */
  search?: { label: string; run: (query: string) => Promise<HistoryGroup[]> };
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{ query: string; groups: HistoryGroup[] } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pathname = usePathname();
  // Navigation from anywhere else (the rail, a command) leaves the panel
  // floating over the new screen. Adjusting during render is the React-blessed
  // form of "reset state when an input changes"; an effect would paint the
  // stale panel for one frame first.
  const [atPath, setAtPath] = useState(pathname);
  if (atPath !== pathname) {
    setAtPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const wanted = query.trim();
  useEffect(() => {
    if (!search || !wanted) return;
    let live = true;
    const timer = setTimeout(() => {
      void search.run(wanted).then(
        (found) => live && setAnswer({ query: wanted, groups: found }),
        () => live && setAnswer({ query: wanted, groups: [] }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [search, wanted]);

  // A stale answer (an earlier query) never shows under the current one.
  const searching = Boolean(wanted) && answer?.query !== wanted;
  const shown = !wanted ? groups : answer?.query === wanted ? answer.groups : [];

  return (
    <div ref={container} className={`relative ${className ?? ""}`}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className={`${historyChipClass} gap-1.5`}
      >
        <History aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          id={panelId}
          className="panel bg-popover text-popover-foreground shadow-raised absolute top-full left-0 z-50 mt-1.5 max-h-[min(70dvh,520px)] w-[min(320px,calc(100vw-2rem))] overflow-y-auto rounded-[9px] p-1.5"
        >
          {search ? (
            <label className="relative mb-1 block">
              <span className="sr-only">{search.label}</span>
              <Search
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
              />
              <input
                type="search"
                // The panel opens to be searched; the trigger is one Tab back.
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={search.label}
                className="placeholder:text-muted-foreground focus-visible:ring-ring h-8 w-full rounded-md bg-transparent pr-2 pl-7 text-body-dense outline-none focus-visible:ring-2"
              />
            </label>
          ) : null}
          {searching ? (
            <p role="status" className="text-muted-foreground px-2 py-1.5 text-label">
              Searching…
            </p>
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-label">
              {wanted ? `Nothing matches “${wanted}”.` : empty}
            </p>
          ) : (
            <nav aria-label={listLabel} className="flex flex-col gap-1">
              {shown.map((group) => (
                <div key={group.key}>
                  <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-label font-medium">{group.label}</p>
                  <ul className="flex flex-col">
                    {group.rows.map((row) => (
                      <li key={row.id}>
                        <Link
                          href={row.href}
                          aria-current={row.id === currentId ? "page" : undefined}
                          onClick={() => setOpen(false)}
                          className="hover:bg-muted focus-visible:ring-ring aria-[current=page]:bg-muted flex h-8 items-center gap-3 rounded-md px-2 text-body-dense outline-none focus-visible:ring-2"
                        >
                          <span className="min-w-0 flex-1 truncate">{row.title}</span>
                          <span className="text-muted-foreground shrink-0 text-label tabular-nums">{row.time}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          )}
        </div>
      ) : null}
    </div>
  );
}
