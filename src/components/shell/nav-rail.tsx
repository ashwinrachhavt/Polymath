"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { destinations, navGroups } from "@/lib/navigation";

/*
 * Desktop navigation. A client island only because the active destination is
 * a pathname comparison; everything else about the shell renders on the server.
 *
 * Width is fixed by agents/design.md (248 px) and collapsed state is not wired
 * yet — a rail that remembers a preference needs a preference to remember.
 *
 * The rail is the one surface that carries the engraving: a faint vertical
 * tooth under the rows. It runs on the chrome, never on content, so the only
 * thing it textures is navigation.
 */
export function NavRail() {
  const pathname = usePathname();

  return (
    <nav aria-label="Destinations" className="hidden w-[248px] shrink-0 md:block">
      {/* top-12 / dvh-3rem so the rail starts below the header and stops at
          the viewport floor instead of sliding under it. */}
      <div className="border-border bg-sidebar engraved sticky top-12 flex h-[calc(100dvh-3rem)] flex-col gap-6 overflow-y-auto border-r px-3 py-4">
        <Link
          href="/"
          className="text-foreground px-2 text-[13px] font-medium tracking-tight"
        >
          Axiom
        </Link>

        <div className="flex flex-col gap-5">
          {navGroups.map((group) => (
            <div key={group} className="flex flex-col gap-0.5">
              {/* Not a heading: these label a nav cluster, and as the first
                  headings in the DOM they would put h2 ahead of the page h1. */}
              <p className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">
                {group}
              </p>
              {destinations
                .filter((d) => d.group === group)
                .map(({ href, label, icon: Icon }) => {
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <Link
                      key={href}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex h-7 items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors",
                        "focus-visible:ring-ring focus-visible:ring-3",
                        active
                          ? "bg-card text-foreground font-medium shadow-[inset_0_1px_0_0_var(--edge-light),0_1px_2px_oklch(0.5_0.01_255/6%)]"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      )}
                    >
                      {/* The active row is marked by a hairline rule on the
                          edge, not by a filled pill — one accessory, and it
                          is the same accessory the header and inspector use. */}
                      {active ? (
                        <span
                          aria-hidden
                          className="bg-primary absolute inset-y-1 -left-3 w-px"
                        />
                      ) : null}
                      <Icon aria-hidden className="size-4 shrink-0" />
                      <span className="truncate">{label}</span>
                    </Link>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}
