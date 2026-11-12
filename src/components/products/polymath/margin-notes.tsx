"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinkPreview } from "@/domains/knowledge/notes";
import { layoutMarginNotes } from "./margin-layout";

/*
 * Margin notes (after numinous.productions/ttft): a [[linked]] note's title
 * and first lines sit in the right margin beside the line that cites it. The
 * margin shows only when the note's own container is wide enough for the
 * reading measure plus the 21rem column (not by viewport: the sidebar and the
 * comments aside both take width). Otherwise the editor itself folds the same
 * previews in under the citing paragraph (wiki-links.ts). A link typed after
 * the page loaded has no preview until the next load, so it gets no card.
 */

/*
 * Margin mode has one source of truth: the container query in globals.css,
 * which sets this property on .note-column when the container fits the
 * measure plus the margin column. The script reads that outcome rather than
 * recomputing the threshold.
 */
export const MARGIN_MODE_PROPERTY = "--margin-notes";

const ESTIMATED_CARD_HEIGHT = 84;
const MAX_VISIBLE_CARDS = 12;

type Anchor = { key: string; top: number };

/** Where each previewed title is cited, relative to the editor, in document order. Re-measures on resize and edits. */
function useAnchors(previews: LinkPreview[], editorRoot: HTMLElement | null): Anchor[] {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const frame = useRef(0);

  const measure = useCallback(() => {
    if (!editorRoot) return;
    const origin = editorRoot.getBoundingClientRect().top;
    const cited = new Map<string, number>();
    for (const el of editorRoot.querySelectorAll<HTMLElement>("[data-wiki-title]")) {
      const title = (el.dataset.wikiTitle ?? "").trim().toLowerCase();
      if (!cited.has(title)) cited.set(title, el.getBoundingClientRect().top - origin);
    }
    const next = previews
      .flatMap((p) => {
        const top = cited.get(p.title.trim().toLowerCase());
        return top === undefined ? [] : [{ key: p.id, top }];
      })
      .sort((a, b) => a.top - b.top);
    setAnchors((prev) =>
      prev.length === next.length && prev.every((a, i) => a.key === next[i].key && a.top === next[i].top) ? prev : next,
    );
  }, [editorRoot, previews]);

  useEffect(() => {
    if (!editorRoot) return;
    const schedule = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(editorRoot);
    const edits = new MutationObserver(schedule);
    edits.observe(editorRoot, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame.current);
      resize.disconnect();
      edits.disconnect();
    };
  }, [editorRoot, measure]);

  return anchors;
}

/** True while the container query in globals.css has the note column in margin mode. */
function useMarginMode(editorRoot: HTMLElement | null): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const column = editorRoot?.closest<HTMLElement>(".note-column");
    const container = column?.closest<HTMLElement>("[data-note-container]");
    if (!column || !container) return;
    const check = () => setOn(getComputedStyle(column).getPropertyValue(MARGIN_MODE_PROPERTY).trim() === "on");
    check();
    const resize = new ResizeObserver(check);
    resize.observe(container);
    return () => resize.disconnect();
  }, [editorRoot]);
  return on;
}

export function MarginNotes({ previews, editorRoot }: { previews: LinkPreview[]; editorRoot: HTMLElement | null }) {
  const marginOn = useMarginMode(editorRoot);
  const anchors = useAnchors(previews, editorRoot);
  const byId = useMemo(() => new Map(previews.map((p) => [p.id, p])), [previews]);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  // Past MAX_VISIBLE_CARDS the rest wait behind "+N more"; once opened they stay open.
  const [showAll, setShowAll] = useState(false);

  // Card heights are known only after they render, and change when the text rewraps.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next: Record<string, number> = {};
        for (const [key, el] of cardRefs.current) next[key] = el.offsetHeight;
        setHeights((prev) => {
          const same =
            Object.keys(next).length === Object.keys(prev).length &&
            Object.entries(next).every(([k, h]) => prev[k] === h);
          return same ? prev : next;
        });
      });
    };
    measure();
    const resize = new ResizeObserver(measure);
    for (const el of cardRefs.current.values()) resize.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [anchors, marginOn, showAll]);

  const placed = useMemo(
    () =>
      layoutMarginNotes(
        anchors.map((a) => ({ ...a, height: heights[a.key] ?? ESTIMATED_CARD_HEIGHT })),
        12,
        showAll ? anchors.length : MAX_VISIBLE_CARDS,
      ),
    [anchors, heights, showAll],
  );
  if (!marginOn || placed.length === 0) return null;

  const visible = placed.filter((p) => !p.hidden);
  const hiddenCount = placed.length - visible.length;
  const last = visible.at(-1);
  const moreTop = last ? last.top + (heights[last.key] ?? ESTIMATED_CARD_HEIGHT) + 12 : 0;

  return (
    <aside aria-label="Linked notes" className="pointer-events-none absolute left-full top-0 ml-6 w-64">
      {visible.map(({ key, top }) => {
        const preview = byId.get(key);
        if (!preview) return null;
        return (
          <article
            key={key}
            ref={(el) => {
              if (el) cardRefs.current.set(key, el);
              else cardRefs.current.delete(key);
            }}
            style={{ top }}
            className="pointer-events-auto absolute left-0 w-full text-xs leading-5"
          >
            <Link
              href={`/polymath/notes?id=${preview.id}`}
              className="font-medium underline-offset-2 hover:underline"
              style={{ color: "var(--link)" }}
            >
              {preview.title}
            </Link>
            {preview.firstParagraph && <p className="mt-0.5 text-muted-foreground">{preview.firstParagraph}</p>}
          </article>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{ top: moreTop, color: "var(--link)" }}
          className="pointer-events-auto absolute left-0 text-xs underline-offset-2 hover:underline"
        >
          +{hiddenCount} more linked notes
        </button>
      )}
    </aside>
  );
}
