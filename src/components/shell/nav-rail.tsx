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
 */
export function NavRail() {
  const pathname = usePathname();

  return (
    <nav aria-label="Destinations" className="hidden w-[248px] shrink-0 md:block">
      <div className="sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto border-r border-border px-3 py-4">
        <Link href="/" className="px-2 text-sm font-medium tracking-tight">
          Axiom
        </Link>

        <div className="flex flex-col gap-5">
          {navGroups.map((group) => (
            <div key={group} className="flex flex-col gap-1">
              <h2 className="text-muted-foreground px-2 text-xs">{group}</h2>
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
                        "flex h-8 items-center gap-2 rounded-lg px-2 text-sm outline-none transition-colors",
                        "focus-visible:ring-ring focus-visible:ring-3",
                        active
                          ? "bg-secondary text-secondary-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon aria-hidden className="size-4 shrink-0" />
                      {label}
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
