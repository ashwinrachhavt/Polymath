"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "cn";

/*
 * A coach mark: a one-time accent callout anchored to the control it explains,
 * from the Composio product-tour reference the owner sent ("Products have a
 * new home - Switch between ... right here."). It renders nothing on the
 * server, shows once per id (localStorage), and dismisses from its action or
 * Escape. No entrance animation: it answers "what changed here", nothing more.
 */
export function CoachMark({
  id,
  title,
  children,
  actionLabel = "Got it",
  align = "end",
}: {
  id: string;
  title: string;
  children?: ReactNode;
  actionLabel?: string;
  align?: "start" | "end";
}) {
  const [hidden, setHidden] = useState(false);
  const key = `axiom-coachmark-${id}`;
  // Server snapshot is "dismissed" so SSR renders nothing; the client snapshot
  // reads localStorage, so a returning visitor never sees the callout twice.
  const storedDismissed = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.localStorage.getItem(key) !== null;
      } catch {
        // Storage unavailable (private mode): stay hidden rather than nag every load.
        return true;
      }
    },
    () => true,
  );

  const dismiss = () => {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // Best effort; hiding for this session still holds.
    }
    setHidden(true);
  };

  // The callout never blocks the page: only its dismiss button takes
  // pointer events, and any click outside it dismisses it (capture phase,
  // so the click still reaches its real target).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hidden || storedDismissed) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  });

  if (hidden || storedDismissed) return null;


  return (
    <div
      role="status"
      onKeyDown={(event) => {
        if (event.key === "Escape") dismiss();
      }}
      ref={rootRef}
      className={cn("pointer-events-none absolute top-full z-40 mt-2 w-64", align === "end" ? "right-0" : "left-0")}
    >
      <div aria-hidden className={cn("bg-primary absolute -top-1 size-2 rotate-45", align === "end" ? "right-3" : "left-3")} />
      <div className="bg-primary text-primary-foreground shadow-raised pointer-events-none rounded-lg p-3">
        <p className="text-[13px] font-medium">{title}</p>
        <div className="mt-1 text-[13px] leading-relaxed opacity-90">{children}</div>
        <button
          type="button"
          onClick={dismiss}
          className="bg-primary-foreground/15 hover:bg-primary-foreground/25 focus-visible:outline-primary-foreground pointer-events-auto mt-2 min-h-7 rounded-md px-2.5 py-1 text-[13px] font-medium focus-visible:outline-2"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
