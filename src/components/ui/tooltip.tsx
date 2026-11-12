"use client";

import { createContext, useContext, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Slot, Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "cn";

/*
 * The one hover/focus hint. Radix supplies the behaviour that makes it
 * accessible: it opens on keyboard focus as well as hover, closes on Escape
 * and blur, never opens on touch, and renders a role="tooltip" node.
 *
 * A tooltip usually repeats a control's name, and the trigger still needs its
 * own accessible name (IconButton passes `label` as aria-label). Radix would
 * also point aria-describedby at the hint, so a screen reader would say the
 * name twice; that link is dropped unless `describes` says the hint adds
 * something the name lacks.
 *
 * The root layout mounts one TooltipProvider so moving along a toolbar skips
 * the delay after the first hint. A Tooltip rendered outside it (a test, a
 * portal) brings its own provider instead of throwing.
 */

const ProviderMounted = createContext(false);

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={300}>
      <ProviderMounted.Provider value>{children}</ProviderMounted.Provider>
    </TooltipPrimitive.Provider>
  );
}

export type TooltipSide = "top" | "right" | "bottom" | "left";

export function Tooltip({
  content,
  shortcut,
  side = "bottom",
  open,
  describes = false,
  children,
}: {
  content: ReactNode;
  /** Shown as a key hint after the text, e.g. "⌘K". */
  shortcut?: string;
  side?: TooltipSide;
  /** Controlled open state; omit to let hover and focus drive it. */
  open?: boolean;
  /** The hint carries more than the trigger's name, so link it as a description. */
  describes?: boolean;
  /** One focusable element; it becomes the trigger. */
  children: ReactElement;
}) {
  const hasProvider = useContext(ProviderMounted);
  const tooltip = (
    <TooltipPrimitive.Root open={open}>
      <TooltipPrimitive.Trigger asChild>
        {describes ? children : <NotDescribed>{children}</NotDescribed>}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-[var(--z-tooltip)] flex max-w-64 items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs leading-snug text-background",
            "motion-safe:data-[state=delayed-open]:animate-in motion-safe:data-[state=delayed-open]:fade-in-0 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0",
          )}
        >
          <span>{content}</span>
          {shortcut ? <kbd className="font-sans text-[0.7rem] opacity-70">{shortcut}</kbd> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}

/* Passes the trigger's props through to the child, minus the description link. */
function NotDescribed({ "aria-describedby": _describedBy, ...props }: ComponentProps<typeof Slot.Root>) {
  return <Slot.Root {...props} />;
}
