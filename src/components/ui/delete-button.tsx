"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Tooltip, type TooltipSide } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";

type Phase = "idle" | "armed" | "deleting";

/*
 * Two-step delete with no dialog. The first click arms it: the button turns
 * destructive, the bin lid lifts, and the hint reads "Click again to delete".
 * The second click deletes. It disarms by itself after a few seconds, on
 * Escape, or when focus leaves, so an armed button is never left lying around.
 *
 * When the caller can restore what it deleted (a soft delete, an archive),
 * pass `undo`: the toast offers it. Without `undo` the toast only confirms,
 * which is why the two clicks exist.
 *
 * `onDelete` should throw on failure; the error is toasted and the button
 * returns to rest. The row's own disappearance is the caller's business
 * (optimistic removal or a refresh), not this button's.
 */
export function DeleteButton({
  label,
  onDelete,
  undo,
  deletedMessage = "Deleted",
  confirmHint = "Click again to delete",
  showLabel = false,
  side,
  size = "icon",
  className,
  disabled,
}: {
  /** At rest: the tooltip and accessible name ("Delete note"). */
  label: string;
  onDelete: () => void | Promise<void>;
  /** Restores the item; offered as "Undo" in the toast. */
  undo?: () => void | Promise<void>;
  deletedMessage?: string;
  /** The armed hint; name the consequence when it is not obvious ("Click again to disconnect. Sends stop."). */
  confirmHint?: string;
  /** Show the word beside the icon, for places an icon alone is ambiguous. */
  showLabel?: boolean;
  side?: TooltipSide;
  size?: "icon" | "icon-sm" | "icon-xs";
  className?: string;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const disarmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (phase !== "armed") return;
    disarmTimer.current = window.setTimeout(() => setPhase("idle"), ARM_WINDOW_MS);
    return () => window.clearTimeout(disarmTimer.current);
  }, [phase]);

  const armed = phase === "armed";
  const hint = armed ? confirmHint : label;

  async function confirm() {
    setPhase("deleting");
    try {
      await onDelete();
    } catch (error) {
      setPhase("idle");
      toast(error instanceof Error && error.message ? error.message : "Could not delete. Try again.", {
        tone: "error",
      });
      return;
    }
    setPhase("idle");
    toast(deletedMessage, undo ? { action: { label: "Undo", onAction: undo } } : {});
  }

  return (
    <Tooltip content={hint} side={side} open={armed ? true : undefined}>
      <button
        type="button"
        aria-label={armed ? `${label}: click again to confirm` : label}
        data-state={phase}
        disabled={disabled || phase === "deleting"}
        onClick={() => {
          if (phase === "idle") setPhase("armed");
          else if (phase === "armed") void confirm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && armed) {
            event.stopPropagation();
            setPhase("idle");
          }
        }}
        onBlur={() => {
          if (armed) setPhase("idle");
        }}
        className={cn(
          "group/delete inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent text-muted-foreground outline-none select-none",
          "transition-[background-color,border-color,color] duration-[var(--dur-micro)]",
          "hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          "data-[state=armed]:border-destructive/40 data-[state=armed]:bg-destructive data-[state=armed]:text-background",
          "disabled:pointer-events-none disabled:opacity-60",
          showLabel ? "h-8 px-2.5 text-body-dense font-medium" : SIZES[size],
          className,
        )}
      >
        <BinIcon open={armed} />
        {showLabel ? <span>{armed ? "Confirm" : "Delete"}</span> : null}
      </button>
    </Tooltip>
  );
}

const ARM_WINDOW_MS = 3000;

const SIZES = { icon: "size-8", "icon-sm": "size-7", "icon-xs": "size-6" } as const;

/* A bin whose lid lifts when armed: transform only, still under reduced motion. */
function BinIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <g
        className={cn(
          "origin-[20px_6px] motion-safe:transition-transform motion-safe:duration-150",
          open && "-translate-y-0.5 -rotate-12",
        )}
      >
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </g>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
