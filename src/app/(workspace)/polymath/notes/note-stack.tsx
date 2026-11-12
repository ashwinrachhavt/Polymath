"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, PenLine, X } from "lucide-react";
import { MarkdownBlocks } from "@/components/markdown";
import { inline } from "@/components/markdown-inline";
import { Tooltip } from "@/components/ui/tooltip";

/*
 * Writing and following links are one surface. The note being written is the
 * first pane; a [[link]] clicked in it (or a backlink under it) opens that note
 * as a reading pane to its right, and a link in that pane opens the next one,
 * the way Andy Matuschak's evergreen notes read. Once the panes outgrow the
 * screen, earlier ones fold to spines that bring them back on a click.
 *
 * The open trail lives in the URL (?id=<written>&stack=<id>,<id>) so it can be
 * shared, reloaded and walked back with the browser. Opening a pane keeps the
 * written note mounted, unsaved keystrokes and all: it is a sibling of the
 * panes, never re-keyed by them. Panes read; "Write here" makes one the note
 * being written.
 */

export type StackNote = {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  updatedAt: string;
  markdown: string;
  backlinks: { id: string; title: string; snippet: string | null }[];
};

/** A note an open pane links to: only what a link and its hover card read. */
export type NoteRef = { id: string; title: string; excerpt: string | null };

const BASE = "/polymath/notes";
/** The written note's pane once others sit beside it: the prose measure and its gutters. */
const EDITOR_WIDTH = 800;
const NOTE_WIDTH = 600;
/** How much of a covered pane stays visible as its spine. */
const SPINE = 40;
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

/** Where pane `pane` sits before any sticky offset applies. */
const naturalLeft = (pane: number) => (pane === 0 ? 0 : EDITOR_WIDTH + (pane - 1) * NOTE_WIDTH);

const editedLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

type Preview = { entry: NoteRef; x: number; y: number };

type StackControls = {
  /** The URL of the trail after following a link out of `fromPane` to `id`. */
  href: (fromPane: number, id: string) => string;
  /** Opens `id` beside `fromPane`; a modified click is left to the browser (a new tab). */
  follow: (event: MouseEvent | null, fromPane: number, id: string) => void;
  /** Linked panes are open, so the written note has a pane's width, not the screen's. */
  crowded: boolean;
};

const StackContext = createContext<StackControls | null>(null);

/** The stack the written note sits in; null outside one (the empty states). */
export function useNoteStack() {
  return useContext(StackContext);
}

export function NoteStack({
  noteId,
  noteTitle,
  editor,
  notes,
  linked = [],
}: {
  /** The note being written: pane 0. */
  noteId: string;
  noteTitle: string;
  editor: ReactNode;
  /** The linked notes open beside it, in trail order. */
  notes: StackNote[];
  /** Notes the open panes link to, so their [[links]] resolve. */
  linked?: NoteRef[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stackIds = useMemo(() => notes.map((n) => n.id), [notes]);
  const byTitle = useMemo(() => {
    const map = new Map<string, NoteRef>();
    for (const entry of linked) {
      const key = entry.title.trim().toLowerCase();
      if (!map.has(key)) map.set(key, entry);
    }
    return map;
  }, [linked]);

  const trailHref = useCallback(
    (ids: string[]) => (ids.length ? `${BASE}?id=${noteId}&stack=${ids.join(",")}` : `${BASE}?id=${noteId}`),
    [noteId],
  );
  // Note k in the trail is pane k + 1; following a link out of a pane drops
  // every pane after it, as in a browser's history.
  const href = useCallback(
    (fromPane: number, id: string) => trailHref([...stackIds.slice(0, fromPane), id]),
    [stackIds, trailHref],
  );

  const scrollToPane = useCallback((pane: number) => {
    scroller.current?.scrollTo({ left: Math.max(0, naturalLeft(pane) - pane * SPINE), behavior: "smooth" });
  }, []);

  const follow = useCallback(
    (event: MouseEvent | null, fromPane: number, id: string) => {
      if (event) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
      }
      // A hover still pending would pop a card for a link that just moved.
      if (previewTimer.current) clearTimeout(previewTimer.current);
      setPreview(null);
      // The written note and panes already on screen to the left are brought
      // back rather than opened twice.
      if (id === noteId) return scrollToPane(0);
      const open = stackIds.indexOf(id);
      if (open !== -1 && open < fromPane + 1) return scrollToPane(open + 1);
      startTransition(() => router.push(href(fromPane, id), { scroll: false }));
    },
    [href, noteId, router, scrollToPane, stackIds],
  );

  // A newly opened pane slides into view at the right edge.
  const lastId = stackIds.at(-1);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !lastId) return;
    el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [lastId]);

  const showPreview = (event: MouseEvent, entry: NoteRef) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreview({ entry, x: rect.left, y: rect.bottom }), 250);
  };
  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    },
    [],
  );
  const hidePreview = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setPreview(null);
  };

  /** A note link: a real anchor (a new tab works), opened as a pane on a plain click. */
  const noteLink = (fromPane: number, entry: NoteRef, label: ReactNode, className: string, key?: number) => (
    <a
      key={key}
      href={href(fromPane, entry.id)}
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
      const open = stackIds.includes(entry.id) || entry.id === noteId;
      return noteLink(fromPane, entry, label, `wiki-link px-0.5 ${open ? "font-medium" : ""}`, i);
    });

  const paneCount = notes.length + 1;
  const crowded = notes.length > 0;
  const titles = [noteTitle || "Untitled note", ...notes.map((n) => n.title || "Untitled note")];
  /** A pane folds to its spine once the next pane slides over it. */
  const covered = (pane: number) =>
    pane < paneCount - 1 && naturalLeft(pane + 1) - scrollLeft <= (pane + 1) * SPINE + SPINE;

  const paneClass = (pane: number) =>
    [
      "relative flex h-full shrink-0 flex-col bg-background md:sticky",
      pane > 0 ? "border-l border-border md:shadow-[-6px_0_16px_-12px_rgb(0_0_0/0.25)]" : "",
      // Phones read one pane at a time: the deepest one.
      pane === paneCount - 1 ? "max-md:w-full!" : "max-md:hidden",
    ].join(" ");

  const spine = (pane: number) =>
    covered(pane) ? (
      <button
        type="button"
        onClick={() => scrollToPane(pane)}
        aria-label={`Show ${titles[pane]}`}
        className="absolute inset-y-0 left-0 z-30 hidden w-10 items-start justify-center bg-background pt-6 hover:bg-muted/40 md:flex"
      >
        <span
          className="truncate text-body-dense font-medium text-muted-foreground"
          style={{ writingMode: "vertical-rl", maxHeight: "calc(100% - 3rem)" }}
        >
          {titles[pane]}
        </span>
      </button>
    ) : null;

  const controls = useMemo(() => ({ href, follow, crowded }), [href, follow, crowded]);

  return (
    <StackContext.Provider value={controls}>
      <div
        ref={scroller}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        aria-busy={pending}
        className="flex h-full min-h-0 overflow-x-auto overflow-y-hidden overscroll-x-contain"
      >
        <section
          aria-label={titles[0]}
          className={`${paneClass(0)} ${crowded ? "" : "min-w-0 flex-1"}`}
          style={crowded ? { width: EDITOR_WIDTH, left: 0 } : undefined}
        >
          {spine(0)}
          <div data-note-scroller className="h-full overflow-y-auto">
            {editor}
          </div>
        </section>

        {notes.map((note, k) => {
          const pane = k + 1;
          return (
            <article
              key={note.id}
              aria-label={note.title || "Untitled note"}
              className={paneClass(pane)}
              style={{ width: NOTE_WIDTH, left: pane * SPINE }}
            >
              {spine(pane)}
              <div className="h-full overflow-y-auto">
                <div className="sticky top-0 z-20 flex h-12 items-center gap-1 bg-background/95 px-4 backdrop-blur md:px-6">
                  {/* Phones show one pane: the way back is the pane before it. */}
                  <Link
                    href={trailHref(stackIds.slice(0, k))}
                    scroll={false}
                    className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-label text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
                  >
                    <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{titles[pane - 1]}</span>
                  </Link>
                  <span className="ml-auto" />
                  <Tooltip content="Write in this note">
                    <Link
                      href={`${BASE}?id=${note.id}`}
                      aria-label={`Write in ${note.title || "Untitled note"}`}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <PenLine className="size-4" aria-hidden />
                    </Link>
                  </Tooltip>
                  <Tooltip content="Close">
                    <Link
                      href={trailHref(stackIds.slice(0, k))}
                      scroll={false}
                      aria-label={`Close ${note.title || "Untitled note"}`}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-4" aria-hidden />
                    </Link>
                  </Tooltip>
                </div>
                <div className="px-6 pb-16 pt-6 md:px-10">
                  <h2
                    className="text-display font-semibold leading-[1.2] tracking-tight"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {note.title || "Untitled note"}
                  </h2>
                  <p className="mt-2 text-data text-muted-foreground">
                    {note.kind === "zettel" ? "Zettel · " : ""}Edited{" "}
                    <span className="readout">{editedLabel(note.updatedAt)}</span>
                    {note.tags.length > 0 ? ` · ${note.tags.map((t) => `#${t}`).join(" ")}` : null}
                  </p>
                  <div className="prose-reading mt-6 flex flex-col font-[family-name:var(--font-reading)]">
                    {note.markdown.trim() ? (
                      <MarkdownBlocks text={note.markdown} renderInline={renderInlineFor(pane)} />
                    ) : (
                      <p className="text-muted-foreground">This note is empty.</p>
                    )}
                  </div>

                  <section aria-label="Links to this note" className="mt-12 border-t border-border pt-6">
                    <h3 className="text-xs font-medium text-muted-foreground">
                      Backlinks <span className="tabular-nums">{note.backlinks.length}</span>
                    </h3>
                    {note.backlinks.length === 0 ? (
                      <p className="mt-3 text-body-dense text-muted-foreground">Nothing links here yet.</p>
                    ) : (
                      <ul className="mt-3 flex flex-col gap-2.5">
                        {note.backlinks.map((b) => (
                          <li key={b.id}>
                            {noteLink(
                              pane,
                              { id: b.id, title: b.title, excerpt: b.snippet },
                              <>
                                <span className="block text-body text-muted-foreground hover:text-foreground">
                                  {b.title || "Untitled note"}
                                </span>
                                {b.snippet && (
                                  <span className="mt-0.5 line-clamp-2 block text-label leading-5 text-muted-foreground/80">
                                    {b.snippet}
                                  </span>
                                )}
                              </>,
                              "block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {preview ? (
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
      ) : null}
    </StackContext.Provider>
  );
}
