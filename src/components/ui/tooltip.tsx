"use client";

import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "radix-ui";

/*
 * A hover and focus label for an icon-only control. The control still carries
 * its own aria-label; the hint is the sighted reader's version of that name,
 * shown after a short pause so passing the pointer over a row of icons does
 * not flash a row of labels. Each hint brings its own provider: there is no
 * app-wide one, and the delay is the same everywhere it is used.
 */
export function Hint({
  label,
  children,
  side = "bottom",
}: {
  label: ReactNode;
  /** One element that accepts a ref (a button, or a Radix trigger rendered asChild). */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="bg-foreground text-background z-50 max-w-64 rounded-md px-2 py-1 text-label leading-snug shadow-md"
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
