"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { TextSegment } from "@/domains/knowledge/passages";
import { recordReadingEventAction, savePassageAction } from "../actions";

/*
 * The reader shell: renders the server-composed article and emits the sitting's
 * reading events - opened on mount, throttled progress as the text scrolls,
 * closed when the tab hides or the page is left. Active seconds accumulate
 * only while the tab is visible: background time is not engagement. Every
 * send carries a fresh client_event_id so the server folds a retried beacon
 * once, and the seconds delta is taken at send time, so a lost close cannot
 * double-count.
 */

const HEARTBEAT_MS = 5_000;
/** Below this scroll delta a heartbeat sends nothing: the position did not move. */
const PROGRESS_EPSILON = 0.005;

export function ReadingShell({ documentId, segments, canSave }: { documentId: string; segments: TextSegment[]; canSave: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selection, setSelection] = useState<{ quote: string; x: number; y: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const lastSentProgressRef = useRef(0);

  useEffect(() => {
    // Generated inside the effect: identity and the clock are impure, and
    // render must stay pure (react-hooks/purity).
    const visitId = crypto.randomUUID();
    let activeMs = 0;
    let tick = Date.now();
    let cancelled = false;

    const measureProgress = () => {
      const el = articleRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const total = rect.height;
      if (total <= 0) return 1;
      const seen = Math.min(total, Math.max(0, window.innerHeight - rect.top));
      return Math.min(1, Math.max(0, seen / total));
    };

    const accumulate = () => {
      const now = Date.now();
      if (document.visibilityState === "visible") activeMs += now - tick;
      tick = now;
    };

    const takeActiveSeconds = () => {
      accumulate();
      const seconds = Math.floor(activeMs / 1000);
      activeMs -= seconds * 1000;
      return seconds;
    };

    const send = (kind: "opened" | "progress" | "closed", progress: number | null) => {
      const activeSeconds = kind === "opened" ? 0 : takeActiveSeconds();
      void recordReadingEventAction({
        documentId,
        visitId,
        kind,
        progress,
        activeSeconds,
        clientEventId: crypto.randomUUID(),
      }).catch(() => {
        // A lost beacon is acceptable: the next heartbeat re-sends the
        // position and the seconds delta keeps accruing client-side.
      });
    };

    const heartbeat = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      const progress = measureProgress();
      const moved = progress !== null && Math.abs(progress - lastSentProgressRef.current) >= PROGRESS_EPSILON;
      if (!moved && activeMs < HEARTBEAT_MS * 3) return;
      if (progress !== null) lastSentProgressRef.current = progress;
      send("progress", progress);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        accumulate();
        send("closed", lastSentProgressRef.current);
      } else {
        tick = Date.now();
      }
    };

    const onPageHide = () => {
      send("closed", lastSentProgressRef.current);
    };

    send("opened", null);
    const interval = window.setInterval(heartbeat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [documentId]);

  const onSelect = () => {
    const sel = window.getSelection();
    const article = articleRef.current;
    const quote = sel?.toString().trim() ?? "";
    if (!canSave || !sel || !article || !quote || sel.rangeCount === 0 || !article.contains(sel.anchorNode) || !article.contains(sel.focusNode)) {
      setSelection(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const box = article.getBoundingClientRect();
    setMessage(null);
    setSelection({ quote, x: Math.max(0, rect.left - box.left), y: rect.bottom - box.top + 6 });
  };

  const save = () => {
    if (!selection) return;
    const quote = selection.quote;
    startTransition(async () => {
      const result = await savePassageAction({ documentId, quote });
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      setMessage(result.ok ? (result.created ? "Saved as a zettel." : "Already saved.") : result.error);
      if (result.ok) router.refresh();
    });
  };

  return (
    <article
      ref={articleRef}
      className="relative max-w-[75ch] whitespace-pre-wrap text-sm leading-7"
      data-reading-article
      onMouseUp={onSelect}
      onKeyUp={onSelect}
    >
      {segments.map((segment, index) =>
        segment.passage ? (
          <mark key={index} className="rounded-sm bg-accent/60 px-0.5 text-foreground" title="Kept as a zettel">
            {segment.text}
            <Link
              href={`/alfred/notes?id=${segment.passage.artifactId}`}
              className="ml-1 align-super text-[10px] text-muted-foreground underline-offset-2 hover:underline"
              aria-label={`Open zettel: ${segment.passage.title}`}
            >
              card
            </Link>
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
      {selection ? (
        <div className="absolute z-10 whitespace-normal" style={{ left: selection.x, top: selection.y }}>
          <Button type="button" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={save} disabled={pending}>
            Save as zettel
          </Button>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="mt-3 whitespace-normal text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </article>
  );
}
