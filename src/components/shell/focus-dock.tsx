"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Timer } from "lucide-react";
import { useWorkspace } from "@/components/workspace/workspace-provider";

type LiveSession = { id: string; state: "running" | "paused"; title: string };

/*
 * The shell's reminder that a focus session is live while you are somewhere
 * else. On canonical routes it reads the REAL session (domains/focus, through
 * /api/v1/focus/live) so a session started on Work follows you across pages and
 * disappears when it ends. The browser-preview store has its own session on
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
  const onWork = pathname === "/neuralflow/work";

  useEffect(() => {
    if (onWork) return; // Work renders the live controls itself.
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/v1/focus/live", { cache: "no-store" });
        if (!response.ok) throw new Error("focus read failed");
        const body = (await response.json()) as { session: LiveSession | null };
        if (!cancelled) setRead({ path: pathname, session: body.session, stale: false });
      } catch {
        // A failed read never claims the session ended, and never presents the last
        // known one as verified: it is kept, marked stale, until a read succeeds.
        if (!cancelled)
          setRead((prev) => (prev?.session ? { path: pathname, session: prev.session, stale: true } : prev));
      }
    }
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname, onWork]);

  const session = read && read.path === pathname ? read.session : null;
  const stale = Boolean(read?.stale);
  if (onWork || !session) return null;
  return (
    <aside
      aria-label="Focus session"
      className="sticky bottom-0 mt-auto border-t border-border bg-background/95 px-4 py-2 backdrop-blur"
    >
      <Link
        href="/neuralflow/work?view=today"
        className="flex min-h-8 items-center gap-3 rounded-md text-[13px] hover:text-app-accent"
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
        className="flex min-h-8 items-center gap-3 rounded-md text-[13px] hover:text-app-accent"
      >
        <Timer aria-hidden className="size-4 shrink-0 text-app-accent" />
        <span className="readout shrink-0 text-xs">Preview focus {state.focus.status}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{task?.title || "Untitled task"}</span>
        <span className="shrink-0 text-xs">Return to preview</span>
      </Link>
    </aside>
  );
}
