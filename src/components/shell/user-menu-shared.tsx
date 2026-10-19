"use client";

import Link from "next/link";
import { Popover } from "radix-ui";
import { cn } from "cn";
import { Activity, Settings, UserRound } from "lucide-react";

/* Shared account-menu pieces with no Clerk imports, so the anonymous menu
 * never pulls the Clerk runtime into the bundle. */

export function MenuItem({ href, icon: Icon, children }: { href: string; icon: typeof Settings; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="hover:bg-accent focus-visible:ring-ring flex h-7 items-center gap-2 rounded-md px-2 text-[13px] outline-none focus-visible:ring-3"
    >
      <Icon aria-hidden className="size-4 opacity-70" />
      {children}
    </Link>
  );
}

export function AnonymousMenu({ signInSlot }: { signInSlot?: React.ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Open account menu"
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
        )}
      >
        <UserRound aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="panel bg-popover text-popover-foreground z-50 w-56 rounded-lg p-1 outline-none">
          <MenuItem href="/settings" icon={Settings}>Settings</MenuItem>
          <MenuItem href="/activity" icon={Activity}>Activity</MenuItem>
          {signInSlot ?? null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
