"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Timer } from "lucide-react";
import { useWorkspace } from "@/components/workspace/workspace-provider";

type LiveSession = { id: string; state: "running" | "paused"; title: string };

// The live-session read is bounded twice (spec W4): a result younger than
// REVALIDATE_MS is reused across navigation mounts, and concurrent read
// intents (a focus event landing on a visibility event, a remount landing on
// an in-flight fetch) join one round trip instead of starting another. The
// cache is module-level on purpose: the session is workspace-global, not per
// page.
const REVALIDATE_MS = 30_000;
// `stale` rides on the cache, not the component: once a read fails, the last
// known session is unverified until a read succeeds, and a cache hit must not
// re-present it as verified.
let liveCache: { at: number; session: LiveSession | null; stale: boolean } | null = null;
// The in-flight fetch itself. StrictMode runs every effect twice in dev: the
// first run's result is discarded (its cleanup cancelled it), so the second
// run must be able to JOIN the fetch instead of being debounced out of one —
// otherwise a fresh dev mount renders nothing until a later event re-triggers.
let inflight: Promise<LiveSession | null> | null = null;

async function fetchLiveSession(): Promise<LiveSession | null> {
  const response = await fetch("/api/v1/focus/live", { cache: "no-store" });
  if (!response.ok) throw new Error("focus read failed");
  const body = (await response.json()) as { session: LiveSession | null };
  return body.session;
}

/*
 * The shell's reminder that a focus session is live while you are somewhere
 * else. On canonical routes it reads the REAL session (domains/focus, through
 * /api/v1/focus/live) so a session started from a task detail follows you
 * across pages and disappears when it ends, linking to Focus, the screen that
 * owns the live controls. The browser-preview store has its own session on
 * /apps screens; that one is shown only there and links to its own screen, so
 * the two are never substituted for each other.
 */
export function FocusDock() {
  const pathname = usePathname();
  // Only the /apps screens own the preview store's session. /settings and /activity
  // are classified as preview for banner purposes, but they sit in the real shell
  // beside real controls, so a real live session must follow the owner there too.
  const preview = pathname.startsWith("/apps/");
  return preview ? <PreviewDock pathname={pathname} /> : <LiveDock pathname={pathname} />;
}

function LiveDock({ pathname }: { pathname: string }) {
  // Keyed by the path it was read on, so a read from an earlier page is never shown as current.
  const [read, setRead] = useState<{ path: string; session: LiveSession | null; stale: boolean } | null>(null);
  const ownsLiveControls = pathname === "/neuralflow/focus";

  useEffect(() => {
    if (ownsLiveControls) return; // The Focus screen renders the live controls itself.
    let cancelled = false;
    async function load(options?: { force?: boolean }) {
      const now = Date.now();
      // The revalidate window serves navigation mounts from the cache; a
      // focus/visibility event is an explicit re-check and always attempts
      // the network — that attempt is what a failed read depends on to
      // surface staleness, so it may never be silently dropped.
      if (!options?.force && liveCache && now - liveCache.at < REVALIDATE_MS) {
        setRead({ path: pathname, session: liveCache.session, stale: liveCache.stale });
        return;
      }
      if (!inflight) {
        inflight = fetchLiveSession()
          .then((session) => {
            liveCache = { at: Date.now(), session, stale: false };
            return session;
          })
          .catch((error) => {
            // A failed read never claims the session ended, and never presents the
            // last known one as verified: it is kept, marked stale, until a read
            // succeeds. The mark lives on the cache so every later cache hit
            // inherits it.
            if (liveCache) liveCache = { ...liveCache, stale: true };
            throw error;
          })
          .finally(() => {
            inflight = null;
          });
      }
      try {
        // Join any fetch another effect instance (or event) already started:
        // everyone awaiting the same round trip reads the same result.
        const session = await inflight;
        if (cancelled) return;
        setRead({ path: pathname, session, stale: false });
      } catch {
        if (cancelled) return;
        setRead((prev) => (prev?.session ? { path: pathname, session: prev.session, stale: true } : prev));
      }
    }
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load({ force: true });
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname, ownsLiveControls]);

  const session = read && read.path === pathname ? read.session : null;
  const stale = Boolean(read?.stale);
  if (ownsLiveControls || !session) return null;
  return (
    <aside
      aria-label="Focus session"
      /* On phones the Destinations bar (sticky bottom-0, z-20, min-h-11 +
         py-1.5 + border + safe-area ~= 57px) covers a bottom-0 dock, so the
         dock sticks above it; on md+ the bar is hidden and the dock owns the
         bottom edge. Keep the offset in step with MobileNav's metrics. */
      className="sticky bottom-[calc(57px+env(safe-area-inset-bottom))] z-10 mt-auto border-t border-border bg-background/95 px-4 py-2 backdrop-blur md:bottom-0"
    >
      <Link
        href="/neuralflow/focus"
        className="flex min-h-8 items-center gap-3 rounded-md text-body-dense hover:text-app-accent"
      >
        <Timer aria-hidden className="size-4 shrink-0 text-app-accent" />
        <span className="readout shrink-0 text-xs">
          {stale ? `Focus ${session.state}, last known` : `Focus ${session.state}`}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {stale ? `${session.title} (status may be out of date)` : session.title}
        </span>
        <span className="shrink-0 text-xs">Return to session</span>
      </Link>
    </aside>
  );
}

function PreviewDock({ pathname }: { pathname: string }) {
  const { state } = useWorkspace();
  if (!state.focus || pathname === "/apps/neuralflow/focus") return null;
  const task = state.tasks.find((record) => record.id === state.focus?.taskId);
  return (
    <aside
      aria-label="Preview focus session"
      className="sticky bottom-0 mt-auto border-t border-border bg-background/95 px-4 py-2 backdrop-blur"
    >
      <Link
        href="/apps/neuralflow/focus"
        className="flex min-h-8 items-center gap-3 rounded-md text-body-dense hover:text-app-accent"
      >
        <Timer aria-hidden className="size-4 shrink-0 text-app-accent" />
        <span className="readout shrink-0 text-xs">Preview focus {state.focus.status}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{task?.title || "Untitled task"}</span>
        <span className="shrink-0 text-xs">Return to preview</span>
      </Link>
    </aside>
  );
}
