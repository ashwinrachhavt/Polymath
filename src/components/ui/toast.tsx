"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { cn } from "cn";

/*
 * Transient confirmations with at most one action ("Undo"). A toast never
 * asks a question and never blocks: it says what just happened and, where the
 * data allows, offers the way back. Errors use the same lane with the error
 * tone so a failed write is never silent.
 *
 * `toast()` works from any client module (no hook needed); the root layout
 * mounts the one <Toaster />.
 */

export type ToastAction = { label: string; onAction: () => void | Promise<void> };
type ToastItem = { id: number; message: string; tone: "default" | "error"; action?: ToastAction; duration: number };

const DEFAULT_DURATION = 6000;
let nextId = 1;

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));

export function toast(
  message: string,
  options: { action?: ToastAction; tone?: "default" | "error"; duration?: number } = {},
): number {
  const id = nextId++;
  const item: ToastItem = {
    id,
    message,
    tone: options.tone ?? "default",
    action: options.action,
    duration: options.duration ?? DEFAULT_DURATION,
  };
  // Newest last; three at most so a burst of deletes never covers the page.
  useToasts.setState((state) => ({ items: [...state.items, item].slice(-3) }));
  return id;
}

export function dismissToast(id: number): void {
  useToasts.setState((state) => ({ items: state.items.filter((item) => item.id !== id) }));
}

export function Toaster() {
  const items = useToasts((state) => state.items);
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[var(--z-toast)] flex flex-col items-center gap-2 p-4 sm:items-end"
    >
      {items.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </section>
  );
}

function ToastRow({ item }: { item: ToastItem }) {
  const [paused, setPaused] = useState(false);
  const [acting, setActing] = useState(false);
  const remaining = useRef(item.duration);

  // Hover or focus pauses the clock so "Undo" never disappears under the
  // pointer; leaving resumes with the time that was left.
  useEffect(() => {
    if (paused || acting) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => dismissToast(item.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, acting, item.id]);

  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-lg border bg-popover py-2 pr-2 pl-3 text-body-dense text-popover-foreground shadow-[var(--shadow-panel)]",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2",
        item.tone === "error" ? "border-destructive/40" : "border-border",
      )}
    >
      <p className={cn("min-w-0 flex-1", item.tone === "error" && "text-destructive")}>{item.message}</p>
      {item.action ? (
        <button
          type="button"
          disabled={acting}
          className="h-7 shrink-0 rounded-md px-2 font-medium text-foreground underline-offset-4 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          onClick={async () => {
            const action = item.action;
            if (!action) return;
            setActing(true);
            try {
              await action.onAction();
              dismissToast(item.id);
            } catch {
              setActing(false);
              toast(`Could not ${action.label.toLowerCase()}. Try again.`, { tone: "error" });
            }
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => dismissToast(item.id)}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
