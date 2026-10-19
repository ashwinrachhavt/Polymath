"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { appForPath, apps, moreDestination } from "@/lib/navigation";
import { cn } from "cn";

/*
 * A phone cannot carry this app's nav bar and an app launcher in the same 44px
 * strip, and the header launcher is the one that has to survive — losing it
 * would strand the owner inside one app.
 *
 * So the bottom bar is the apps themselves: it is the launcher, at thumb range.
 * Within an app, that app's sections are reached from its home page or from the
 * More screen, which lists every destination grouped by app.
 *
 * Target size is 44px, above the 24px floor in agents/design.md, because a
 * thumb is not a cursor.
 */
export function MobileNav() {
  const pathname = usePathname();
  const items = [...apps, moreDestination];

  return (
    <nav
      aria-label="Apps"
      className="border-border bg-background sticky bottom-0 z-20 flex border-t md:hidden"
    >
      {items.map(({ href, label, icon: Icon, ...rest }) => {
        const active = "slug" in rest ? appForPath(pathname)?.slug === rest.slug : pathname === href;
        // `short` only exists on apps; the More entry has no such field.
        const text = "short" in rest ? rest.short : label;
        return (
          <Link
            key={href}
            href={href}
            prefetch={true}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              active ? "text-app-accent font-medium" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            <span className="truncate px-1">{text}</span>
          </Link>
        );
      })}
    </nav>
  );
}
