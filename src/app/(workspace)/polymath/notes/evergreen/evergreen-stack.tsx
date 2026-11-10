"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, PenLine, Search } from "lucide-react";
import { MarkdownBlocks } from "@/components/markdown";
import { inline } from "@/components/markdown-inline";

export type StackIndexEntry = {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  updatedAt: string;
  excerpt: string | null;
};

export type StackNote = {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  updatedAt: string;
  markdown: string;
  backlinks: { id: string; title: string; snippet: string | null }[];
};

const BASE = "/polymath/notes/evergreen";
const INDEX_WIDTH = 352;
const NOTE_WIDTH = 620;
/** How much of a covered pane stays visible as its spine. */
const SPINE = 40;
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

const hrefFor = (ids: string[]) => (ids.length ? `${BASE}?stack=${ids.join(",")}` : BASE);
/** Where pane `pane` sits before any sticky offset applies. */
const naturalLeft = (pane: number) => (pane === 0 ? 0 : INDEX_WIDTH + (pane - 1) * NOTE_WIDTH);

const editedLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

type Preview = { entry: StackIndexEntry; x: number; y: number };

type GroupBy = "tag" | "recency" | "kind";
const GROUPINGS: { value: GroupBy; label: string }[] = [
  { value: "tag", label: "Tag" },
  { value: "recency", label: "Recency" },
  { value: "kind", label: "Kind" },
];
const DAY = 86_400_000;
const RECENCY = ["This week", "This month", "Last 3 months", "Older"];

/** Board columns in display order; empty groups are dropped. */
function groupEntries(entries: StackIndexEntry[], by: GroupBy, now: number): [string, StackIndexEntry[]][] {
  const columns = new Map<string, StackIndexEntry[]>();
  const columnOf = (e: StackIndexEntry) => {
    if (by === "kind") return e.kind === "zettel" ? "Zettels" : "Notes";
    if (by === "tag") return e.tags[0] ? `#${e.tags[0]}` : "Untagged";
    const age = now - new Date(e.updatedAt).getTime();
    return RECENCY[age < 7 * DAY ? 0 : age < 30 * DAY ? 1 : age < 90 * DAY ? 2 : 3];
  };
  for (const entry of entries) {
    const column = columnOf(entry);
    columns.set(column, [...(columns.get(column) ?? []), entry]);
  }
  const all = [...columns.entries()];
  if (by === "recency") return all.sort(([a], [b]) => RECENCY.indexOf(a) - RECENCY.indexOf(b));
  return all.sort(
    ([a, x], [b, y]) =>
      Number(a === "Untagged") - Number(b === "Untagged") || y.length - x.length || a.localeCompare(b),
  );
}

export function EvergreenStack({
  index,
  notes,
  linked = [],
}: {
  index: StackIndexEntry[];
  notes: StackNote[];
  /** Notes the open panes link to that fall outside the capped index. */
  linked?: StackIndexEntry[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  // Recency buckets are relative to when the board opened; read the clock once.
  const [now] = useState(() => Date.now());
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (index.some((e) => e.tags.length) ? "tag" : "recency"));
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stackIds = useMemo(() => notes.map((n) => n.id), [notes]);
  const byTitle = useMemo(() => {
    const map = new Map<string, StackIndexEntry>();
    for (const entry of [...index, ...linked]) {
      const key = entry.title.trim().toLowerCase();
      if (!map.has(key)) map.set(key, entry);
    }
    return map;
  }, [index, linked]);
  const byId = useMemo(() => new Map([...linked, ...index].map((e) => [e.id, e])), [index, linked]);

  // Pane 0 is the index; note k in the stack is pane k + 1.
  const scrollToPane = useCallback((pane: number) => {
    scroller.current?.scrollTo({ left: Math.max(0, naturalLeft(pane) - pane * SPINE), behavior: "smooth" });
  }, []);

  /** The trail after following a link out of `fromPane` to `targetId`. */
  const trailTo = useCallback(
    (fromPane: number, targetId: string) => [...stackIds.slice(0, fromPane), targetId],
    [stackIds],
  );

  const follow = useCallback(
    (event: MouseEvent, fromPane: number, targetId: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      setPreview(null);
      const open = stackIds.indexOf(targetId);
      if (open !== -1 && open < fromPane + 1) {
        // Already on screen to the left: bring it back rather than duplicate it.
        scrollToPane(open + 1);
        return;
      }
      startTransition(() => router.push(hrefFor(trailTo(fromPane, targetId)), { scroll: false }));
    },
    [router, scrollToPane, stackIds, trailTo],
  );

  // A newly opened pane slides into view at the right edge.
  const lastId = stackIds.at(-1);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !lastId) return;
    el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [lastId]);

  const showPreview = (event: MouseEvent, entry: StackIndexEntry) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreview({ entry, x: rect.left, y: rect.bottom }), 250);
  };
  const hidePreview = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setPreview(null);
  };

  /** A note link: a real anchor (new tab works), opened as a pane on a plain click. */
  const noteLink = (fromPane: number, entry: StackIndexEntry, label: ReactNode, className: string, key?: number) => (
    <a
      key={key}
      href={hrefFor(trailTo(fromPane, entry.id))}
      onClick={(e) => follow(e, fromPane, entry.id)}
      onMouseEnter={(e) => showPreview(e, entry)}
      onMouseLeave={hidePreview}
      aria-current={stackIds.includes(entry.id) ? "page" : undefined}
      className={className}
    >
      {label}
    </a>
  );

  const renderInlineFor = (fromPane: number) => (span: string) =>
    span.split(WIKI_LINK).map((part, i) => {
      if (i % 2 === 0) return <span key={i}>{inline(part)}</span>;
      const [target, alias] = part.split("|").map((s) => s.trim());
      const entry = byTitle.get(target.toLowerCase());
      const label = alias || target;
      if (!entry) {
        return (
          <span key={i} title="No note with this title yet" className="text-muted-foreground">
            {label}
          </span>
        );
      }
      const open = stackIds.includes(entry.id);
      return noteLink(fromPane, entry, label, `wiki-link px-0.5 ${open ? "font-medium" : ""}`, i);
    });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return index;
    return index.filter((e) => e.title.toLowerCase().includes(q) || e.excerpt?.toLowerCase().includes(q));
  }, [index, query]);

  const searchBox = (className: string) => (
    <label className={`relative block ${className}`}>
      <span className="sr-only">Filter notes</span>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by title or text"
        className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-2 text-body-dense outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      />
    </label>
  );

  const previewCard = preview ? (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-80 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      style={{ left: Math.max(8, Math.min(preview.x, window.innerWidth - 336)), top: preview.y + 6 }}
    >
      <p className="text-body-dense font-medium">{preview.entry.title || "Untitled"}</p>
      <p className="mt-1.5 line-clamp-6 text-xs leading-relaxed text-muted-foreground">
        {preview.entry.excerpt || "This note is empty."}
      </p>
    </div>
  ) : null;

  const paneCount = notes.length + 1;
  const titles = ["Notes", ...notes.map((n) => n.title)];
  /** A pane folds to its spine once the next pane slides over it. */
  const covered = (pane: number) =>
    pane < paneCount - 1 && naturalLeft(pane + 1) - scrollLeft <= (pane + 1) * SPINE + SPINE;

  const paneClass = (pane: number) =>
    [
      "relative flex h-full shrink-0 flex-col bg-background md:sticky",
      pane > 0 ? "border-l border-border md:shadow-[-6px_0_16px_-12px_rgb(0_0_0/0.25)]" : "",
      // Phones read one pane at a time: the deepest one.
      pane === paneCount - 1 ? "max-md:w-full" : "max-md:hidden",
    ].join(" ");

  const spine = (pane: number) =>
    covered(pane) ? (
      <button
        type="button"
        onClick={() => scrollToPane(pane)}
        aria-label={`Show ${titles[pane]}`}
        className="absolute inset-y-0 left-0 z-10 hidden w-10 items-start justify-center bg-background pt-6 hover:bg-muted/40 md:flex"
      >
        <span
          className="truncate text-body-dense font-medium text-muted-foreground"
          style={{ writingMode: "vertical-rl", maxHeight: "calc(100% - 3rem)" }}
        >
          {titles[pane]}
        </span>
      </button>
    ) : null;

  const backRow = (pane: number) =>
    pane > 0 ? (
      <Link
        href={hrefFor(stackIds.slice(0, pane - 1))}
        scroll={false}
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground md:hidden"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {titles[pane - 1]}
      </Link>
    ) : null;

  if (notes.length === 0) {
    const ordered = groupEntries(filtered, groupBy, now);
    return (
      <div className="flex h-[calc(100dvh-var(--topbar-h,48px))] min-h-0 flex-col">
        <header className="flex flex-wrap items-end justify-between gap-4 px-8 pb-5 pt-10">
          <div>
            <h1 className="text-2xl" style={{ fontFamily: "var(--font-display)" }}>
              Notes
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {index.length} notes · open one and follow its links; each opens beside the last.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="radiogroup"
              aria-label="Group notes by"
              className="flex h-8 rounded-md border border-border p-0.5"
            >
              {GROUPINGS.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  role="radio"
                  aria-checked={groupBy === g.value}
                  onClick={() => setGroupBy(g.value)}
                  className={`rounded px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
                    groupBy === g.value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {searchBox("w-64")}
            <Link
              href="/polymath/notes"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-body-dense hover:bg-muted/40"
            >
              <PenLine className="size-3.5" aria-hidden />
              Editor
            </Link>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-8 pb-8 max-md:flex-col max-md:overflow-y-auto">
          {ordered.length === 0 && (
            <p className="text-body-dense text-muted-foreground">
              {index.length === 0 ? "No notes yet." : "Nothing matches that filter."}
            </p>
          )}
          {ordered.map(([column, entries]) => (
            <section
              key={column}
              aria-label={column}
              className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/30 max-md:w-full md:max-h-full"
            >
              <h2 className="flex items-center justify-between px-3 pb-2 pt-3 text-xs font-medium text-muted-foreground">
                <span>{column}</span>
                <span className="readout">{entries.length}</span>
              </h2>
              <ul className="flex flex-col gap-2 overflow-y-auto px-2 pb-2">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    {noteLink(
                      0,
                      entry,
                      <>
                        <span className="block text-body-dense font-medium leading-snug">
                          {entry.title || "Untitled"}
                        </span>
                        {entry.excerpt && (
                          <span className="mt-1.5 line-clamp-3 block text-xs leading-relaxed text-muted-foreground">
                            {entry.excerpt}
                          </span>
                        )}
                        <span className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span className="readout">{editedLabel(entry.updatedAt)}</span>
                          {entry.kind === "zettel" && <span>zettel</span>}
                        </span>
                      </>,
                      "block rounded-md border border-border bg-background px-3 py-2.5 shadow-xs transition-colors hover:border-foreground/25",
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {previewCard}
      </div>
    );
  }

  return (
    <div className="h-[calc(100dvh-var(--topbar-h,48px))] min-h-0">
      <div
        ref={scroller}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        aria-busy={pending}
        className="flex h-full overflow-x-auto overflow-y-hidden overscroll-x-contain"
      >
        {/* Pane 0: the index of every note. */}
        <section aria-label="All notes" className={paneClass(0)} style={{ width: INDEX_WIDTH, left: 0 }}>
          {spine(0)}
          <div className="flex h-full flex-col overflow-y-auto px-7 pb-10 pt-10">
            <h1 className="text-xl" style={{ fontFamily: "var(--font-display)" }}>
              Notes
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {index.length} notes · follow a link and it opens beside this one.
            </p>
            {searchBox("mt-5 w-full")}
            <ul className="mt-4 flex flex-col">
              {filtered.map((entry) => (
                <li key={entry.id}>
                  {noteLink(
                    0,
                    entry,
                    <>
                      <span className="block truncate text-body-dense">{entry.title || "Untitled"}</span>
                      {entry.excerpt && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{entry.excerpt}</span>
                      )}
                    </>,
                    `-mx-2 block rounded-md px-2 py-1.5 ${
                      stackIds[0] === entry.id ? "bg-muted/70" : "hover:bg-muted/40"
                    }`,
                  )}
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="py-4 text-body-dense text-muted-foreground">
                  {index.length === 0 ? "No notes yet." : "Nothing matches that filter."}
                </li>
              )}
            </ul>
          </div>
        </section>

        {notes.map((note, k) => {
          const pane = k + 1;
          return (
            <article
              key={note.id}
              aria-label={note.title}
              className={paneClass(pane)}
              style={{ width: NOTE_WIDTH, left: pane * SPINE }}
            >
              {spine(pane)}
              <div className="h-full overflow-y-auto px-10 pb-16 pt-10">
                {backRow(pane)}
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {note.kind === "zettel" ? "Zettel · " : ""}Tended{" "}
                    <span className="readout">{editedLabel(note.updatedAt)}</span>
                  </span>
                  <Link
                    href={`/polymath/notes?id=${note.id}`}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted/50 hover:text-foreground"
                  >
                    <PenLine className="size-3.5" aria-hidden />
                    Edit
                  </Link>
                </div>
                <h2 className="mt-3 text-2xl leading-tight" style={{ fontFamily: "var(--font-display)" }}>
                  {note.title || "Untitled"}
                </h2>
                {note.tags.length > 0 && (
                  <p className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    {note.tags.map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </p>
                )}
                <div className="prose-reading mt-6 flex flex-col gap-1.5">
                  {note.markdown.trim() ? (
                    <MarkdownBlocks text={note.markdown} renderInline={renderInlineFor(pane)} />
                  ) : (
                    <p className="text-muted-foreground">This note is empty.</p>
                  )}
                </div>

                <section aria-label="Links to this note" className="mt-12 border-t border-border pt-6">
                  <h3 className="text-body-dense font-medium text-muted-foreground">Links to this note</h3>
                  {note.backlinks.length === 0 ? (
                    <p className="mt-3 text-body-dense text-muted-foreground">Nothing links here yet.</p>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-2">
                      {note.backlinks.map((b) => {
                        const entry = byId.get(b.id) ?? {
                          id: b.id,
                          title: b.title,
                          kind: "note",
                          tags: [],
                          updatedAt: note.updatedAt,
                          excerpt: b.snippet,
                        };
                        return (
                          <li key={b.id}>
                            {noteLink(
                              pane,
                              entry,
                              <>
                                <span className="block text-body-dense font-medium">{b.title || "Untitled"}</span>
                                {b.snippet && (
                                  <span className="mt-1 line-clamp-3 block text-xs leading-relaxed text-muted-foreground">
                                    {b.snippet}
                                  </span>
                                )}
                              </>,
                              "block rounded-md border border-border bg-muted/20 px-3 py-2.5 hover:border-foreground/25 hover:bg-muted/40",
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            </article>
          );
        })}
      </div>

      {previewCard}
    </div>
  );
}
