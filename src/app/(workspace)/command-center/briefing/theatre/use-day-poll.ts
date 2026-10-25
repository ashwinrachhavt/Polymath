"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/*
 * The theatre's transport (ASH-308): polling, by deliberate scope. While the
 * tab is visible the projection refreshes every 30 seconds; refocus refetches
 * immediately; a hidden tab issues no requests. The refresh is the RSC
 * refetch (router.refresh) - the server component re-reads the projection, so
 * there is no second endpoint to keep honest.
 *
 * A failed refresh keeps the last good render and moves the staleness
 * marker: the theatre never clears itself.
 */

const POLL_MS = 30_000;

export function useDayPoll(): { asOf: Date | null; stale: boolean } {
  const router = useRouter();
  const [asOf, setAsOf] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (refreshingRef.current || document.visibilityState !== "visible") return;
      refreshingRef.current = true;
      try {
        router.refresh();
        if (!cancelled) {
          setAsOf(new Date());
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        refreshingRef.current = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);

  return { asOf, stale };
}
