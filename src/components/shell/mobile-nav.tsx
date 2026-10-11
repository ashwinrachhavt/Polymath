"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { mobileDestinations, moreDestination } from "@/lib/navigation";

/*
 * The bottom bar is the same destination list as the rail, cut down to the
 * four that fit plus More. Target size is 44 px, above the 24 px floor in
 * agents/design.md, because a thumb is not a cursor.
 */
export function MobileNav() {
  const pathname = usePathname();
  const items = [...mobileDestinations, moreDestination];

  return (
    <nav
      aria-label="Destinations"
      className="border-border bg-background engraved sticky bottom-0 z-20 flex border-t md:hidden"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
