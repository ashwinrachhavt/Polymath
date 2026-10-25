"use client";

import { cn } from "cn";

/*
 * The one switch: a button with role="switch", a 20px track and a 16px knob.
 * The on-state colour is the variant: `ink` (near-black on light, white on
 * dark) for settings rows where the state itself is the information, and
 * `accent` where the primary action colour is wanted.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  variant = "ink",
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  variant?: "ink" | "accent";
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        checked ? (variant === "accent" ? "bg-primary" : "bg-foreground") : "bg-muted-foreground/30",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 left-0 size-4 rounded-full bg-background transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
