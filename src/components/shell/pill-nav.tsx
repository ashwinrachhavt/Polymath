"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import {
  additionalDestinationsIn,
  appForPath,
  apps,
  destinationForPath,
  destinationsIn,
  type AppDefinition,
  type Destination,
} from "@/lib/navigation";
import { cn } from "cn";

/*
 * The Dao pattern: one centered pill of words, the active section a dark pill
 * inside it. Sections only — no icons, no counts — so the bar reads as a
 * sentence, not a toolbar. The workshop tools (preview surfaces, coach) fold
 * into the last pill; while one of them is open that pill takes its name, so
 * the bar still answers "where am I".
 *
 * On a route with no app (Reviews, Activity, Settings, home) the pill lists
 * the apps instead. The landmark keeps the rail's old name, "Workspace".
 */

type Item = { href: string; label: string; active: boolean };

function Pill({ item }: { item: Item }) {
  return (
    <Link
      href={item.href}
      prefetch={true}
      aria-current={item.active ? "page" : undefined}
      className={cn(
        "flex h-7 items-center rounded-full px-3 text-[13px] whitespace-nowrap outline-none",
        "focus-visible:ring-ring focus-visible:ring-3",
        item.active
          ? "bg-primary text-primary-foreground font-medium"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {item.label}
    </Link>
  );
}

export function PillNav() {
  const pathname = usePathname();
  const app = appForPath(pathname);

  let items: Item[];
  let more: (Destination | AppDefinition)[];
  let activeMore: Destination | undefined;
  if (app) {
    const active = destinationForPath(pathname);
    const additional = additionalDestinationsIn(app.slug);
    activeMore = additional.find((d) => pathname === d.href || pathname.startsWith(d.href + "/"));
    items = destinationsIn(app.slug).map((d) => ({ href: d.href, label: d.label, active: !activeMore && active?.href === d.href }));
    more = additional;
  } else {
    items = apps.map((a) => ({ href: a.href, label: a.label, active: false }));
    more = [];
  }

  return (
    <nav
      aria-label="Workspace"
      className="border-border bg-card hidden items-center gap-0.5 rounded-full border p-1 shadow-[0_1px_2px_rgb(0_0_0/0.04)] lg:flex"
    >
      {items.map((item) => (
        <Pill key={item.href} item={item} />
      ))}
      {more.length > 0 ? (
        <Popover.Root>
          <Popover.Trigger
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-3 text-[13px] whitespace-nowrap outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              activeMore
                ? "bg-primary text-primary-foreground font-medium"
                : "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground",
            )}
          >
            {activeMore ? null : <MoreHorizontal aria-hidden className="size-3.5" />}
            {activeMore?.label ?? "More"}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="center"
              sideOffset={8}
              className="panel bg-popover text-popover-foreground z-50 w-52 rounded-lg p-1 outline-none"
            >
              {more.map((d) => (
                <Link
                  key={d.href}
                  href={d.href}
                  prefetch={true}
                  aria-current={activeMore?.href === d.href ? "page" : undefined}
                  className="hover:bg-accent focus-visible:ring-ring flex h-7 items-center gap-2 rounded-md px-2 text-[13px] outline-none focus-visible:ring-3"
                >
                  <d.icon aria-hidden className="size-4 opacity-70" />
                  {d.label}
                </Link>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </nav>
  );
}
