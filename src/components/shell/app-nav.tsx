"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { destinationForPath, destinationsIn, type AppDefinition } from "@/lib/navigation";

/*
 * One app's own navigation. Each app renders this with its own shape:
 *
 * - `rail` (Command Center) — a full-height lateral rail. An operations desk
 *   keeps its sections in view because you move between them constantly.
 * - `bar` (NeuralFlow, Alfred) — a horizontal strip under the header. These are
 *   places you read and work in, and a rail would take width from the material.
 *
 * Both read like Notion's sidebar: a quiet neutral ground, 13px labels, small
 * low-contrast glyphs, and the current row marked by a soft fill and a darker
 * label. The app accent is spent on the launcher and primary buttons; putting
 * it on the nav too made every row compete, which is the opposite of calm.
 */
export function AppNav({ app }: { app: AppDefinition }) {
  const pathname = usePathname();
  const items = destinationsIn(app.slug);
  const activeHref = destinationForPath(pathname)?.href;

  if (app.nav === "bar") {
    return (
      <nav aria-label={`${app.label} sections`} className="border-border border-b px-3 md:px-4">
        <ul className="flex items-center gap-0.5 overflow-x-auto">
          {items.map(({ href, label, icon: Icon }) => {
            const active = activeHref === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-9 items-center gap-1.5 rounded-md px-2 text-[13px] outline-none transition-colors",
                    "focus-visible:ring-ring focus-visible:ring-3",
                    active
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-70")} />
                  <span className="truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav
      aria-label={`${app.label} sections`}
      className="border-border bg-sidebar hidden w-[224px] shrink-0 border-r md:block"
    >
      {/* top-12 / dvh-3rem so the rail starts below the header and stops at the
          viewport floor instead of sliding under it. */}
      <div className="sticky top-12 flex h-[calc(100dvh-3rem)] flex-col gap-3 overflow-y-auto py-3">
        <div>
          <p className="text-muted-foreground/80 px-4 pb-1 text-[11px] font-medium">{app.label}</p>
          <div className="flex flex-col gap-px px-2">
            {items.map(({ href, label, icon: Icon }) => {
              const active = activeHref === href;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors",
                    "focus-visible:ring-ring focus-visible:ring-3",
                    active
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-70")} />
                  <span className="truncate">{label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
