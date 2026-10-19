"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { recordReadingEventAction } from "../actions";

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

export function ReadingShell({ documentId, children }: { documentId: string; children: ReactNode }) {
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

  return (
    <article
      ref={articleRef}
      className="max-w-[75ch] whitespace-pre-wrap text-sm leading-7"
      data-reading-article
    >
      {children}
    </article>
  );
}
