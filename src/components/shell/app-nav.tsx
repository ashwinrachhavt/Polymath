"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { additionalDestinationsIn, destinationForPath, destinationsIn, type AppDefinition, type Destination } from "@/lib/navigation";

export function AppNav({ app }: { app: AppDefinition }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items = destinationsIn(app.slug);
  const additional = additionalDestinationsIn(app.slug);
  const activeHref = destinationForPath(pathname)?.href;
  const additionalActive = additional.some((item) => item.href === activeHref);

  function itemLink({ href, label, icon: Icon }: Destination) {
    const active = activeHref === href;
    return <Link
      key={href}
      href={href}
      onClick={() => setOpen(false)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors",
        active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-70")} />
      <span className="truncate">{label}</span>
    </Link>;
  }

  if (app.nav === "bar") {
    return <nav aria-label={`${app.label} sections`} className="border-border hidden shrink-0 border-b px-3 md:block md:px-4">
      <div className="flex min-h-11 items-center gap-1">
        {items.map(itemLink)}
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger className={cn("flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors hover:bg-muted", additionalActive ? "bg-muted text-foreground font-medium" : "text-muted-foreground")}>
            More features <ChevronDown aria-hidden className="size-3.5" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={6} className="panel bg-popover text-popover-foreground z-50 max-h-[65dvh] w-64 overflow-y-auto rounded-lg p-2">
              <p className="px-2 py-2 text-xs text-muted-foreground">{app.label} browser preview tools</p>
              {additional.map(itemLink)}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </nav>;
  }

  return <nav aria-label={`${app.label} sections`} className="border-border bg-sidebar hidden w-[224px] shrink-0 border-r md:block">
    <div className="sticky top-12 flex h-[calc(100dvh-3rem)] flex-col gap-4 overflow-y-auto py-3">
      <div>
        <p className="text-muted-foreground px-4 pb-1 text-[11px] font-medium uppercase tracking-wider">{app.label}</p>
        <div className="flex flex-col gap-px px-2">{items.map(itemLink)}</div>
      </div>
      <div>
        <p className="text-muted-foreground px-4 pb-1 text-[11px] font-medium uppercase tracking-wider">More features</p>
        <div className="flex flex-col gap-px px-2">{additional.map(itemLink)}</div>
      </div>
    </div>
  </nav>;
}
