"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { Grip } from "lucide-react";
import { cn } from "cn";
import { destinationForPath, destinations } from "@/lib/navigation";

/*
 * The destination launcher, top right next to the account menu: one grid
 * icon opens every destination, mirroring the rail. With one product there
 * is nothing to switch between, so this is a wayfinder — handy when the rail
 * is collapsed — not a switcher.
 *
 * Radix Popover rather than a hand-rolled dropdown: focus trap, escape, click
 * outside, and focus-return-to-trigger all come free, and the design language
 * forbids re-implementing what a primitive already does.
 */
export function AppLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const activeHref = destinationForPath(pathname)?.href;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Open destinations"
        title="Destinations"
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
        )}
      >
        <Grip aria-hidden className="size-4" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="panel bg-popover text-popover-foreground shadow-raised z-50 w-[284px] rounded-xl p-2 outline-none"
        >
          <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px] font-medium uppercase tracking-wider">Destinations</p>
          <div className="grid grid-cols-3 gap-1">
            {destinations.map(({ href, label, purpose, icon: Icon }) => {
              const active = activeHref === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "true" : undefined}
                  title={purpose}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-center outline-none",
                    "hover:bg-accent focus-visible:ring-ring focus-visible:ring-3",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon aria-hidden className={cn("size-4", active && "text-app-accent")} />
                  <span className="text-[11px] leading-tight font-medium">{label}</span>
                </Link>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
