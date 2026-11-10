"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LinkPreview } from "@/domains/knowledge/notes";
import { layoutMarginNotes } from "./margin-layout";

/*
 * Margin notes (after numinous.productions/ttft): a [[linked]] note's title
 * and first lines sit in the right margin beside the line that cites it. At
 * lg and up the cards are absolutely positioned against the editor's wiki-link
 * decorations; below lg there is no margin, so the same previews fold into
 * <details> under the editor. A link typed after the page loaded has no
 * preview until the next load, so it gets no card.
 */

const ESTIMATED_CARD_HEIGHT = 84;

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

function scrollToBacklinks() {
  document.getElementById("note-backlinks")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function MarginNotes({ previews, editorRoot }: { previews: LinkPreview[]; editorRoot: HTMLElement | null }) {
  const anchors = useAnchors(previews, editorRoot);
  const byId = useMemo(() => new Map(previews.map((p) => [p.id, p])), [previews]);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});

  // Card heights are known only after they render; measure on the next frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const next: Record<string, number> = {};
      for (const [key, el] of cardRefs.current) next[key] = el.offsetHeight;
      setHeights((prev) => {
        const same =
          Object.keys(next).length === Object.keys(prev).length &&
          Object.entries(next).every(([k, h]) => prev[k] === h);
        return same ? prev : next;
      });
    });
    return () => cancelAnimationFrame(id);
  }, [anchors]);

  const placed = useMemo(
    () => layoutMarginNotes(anchors.map((a) => ({ ...a, height: heights[a.key] ?? ESTIMATED_CARD_HEIGHT }))),
    [anchors, heights],
  );
  if (placed.length === 0) return null;

  const visible = placed.filter((p) => !p.hidden);
  const hiddenCount = placed.length - visible.length;
  const last = visible.at(-1);
  const moreTop = last ? last.top + (heights[last.key] ?? ESTIMATED_CARD_HEIGHT) + 12 : 0;

  return (
    <>
      <aside
        aria-label="Linked notes"
        className="pointer-events-none absolute left-full top-0 ml-6 hidden w-64 lg:block"
      >
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
            onClick={scrollToBacklinks}
            style={{ top: moreTop, color: "var(--link)" }}
            className="pointer-events-auto absolute left-0 text-xs underline-offset-2 hover:underline"
          >
            +{hiddenCount} more linked notes
          </button>
        )}
      </aside>
      <div role="group" aria-label="Linked notes (inline)" className="mt-4 flex flex-col gap-1 lg:hidden">
        {placed.map(({ key }) => {
          const preview = byId.get(key);
          if (!preview) return null;
          return (
            <details key={key} className="text-body-dense">
              <summary className="cursor-pointer" style={{ color: "var(--link)" }}>
                {preview.title}
              </summary>
              <div className="mt-1 pl-4 text-xs leading-5 text-muted-foreground">
                {preview.firstParagraph && <p>{preview.firstParagraph}</p>}
                <Link
                  href={`/polymath/notes?id=${preview.id}`}
                  className="underline-offset-2 hover:underline"
                  style={{ color: "var(--link)" }}
                >
                  Open note
                </Link>
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}
