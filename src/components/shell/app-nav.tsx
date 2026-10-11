"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { destinationForPath, destinationsIn, type AppDefinition } from "@/lib/navigation";

/*
 * One app's own navigation. Each app renders this with its own shape, and the
 * shape is the app's personality expressed as structure:
 *
 * - `rail` (Command Center) — a full-height lateral rail. An operations desk
 *   keeps its sections in view because you move between them constantly.
 * - `bar` (NeuralFlow, Alfred) — a horizontal strip under the header. These are
 *   places you read and work in, and a rail would take width from the material.
 *
 * The active row's accent rule uses `--app-accent`, which is scoped by the
 * `[data-app]` attribute the app shell sets — so the same component lights up
 * cyan in Command Center, green in NeuralFlow, violet in Alfred without knowing
 * which app it is in.
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
                    "relative flex h-9 items-center gap-1.5 px-2 text-[13px] outline-none transition-colors",
                    "focus-visible:ring-ring focus-visible:ring-3",
                    active
                      ? "text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{label}</span>
                  {/* A rule under the active tab, on the accent — the same
                      accessory the rail uses, turned 90 degrees. */}
                  {active ? (
                    <span aria-hidden className="bg-app-accent absolute inset-x-1 -bottom-px h-px" />
                  ) : null}
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
      className="border-border bg-sidebar engraved hidden w-[212px] shrink-0 border-r md:block"
    >
      {/* top-12 / dvh-3rem so the rail starts below the header and stops at the
          viewport floor instead of sliding under it. */}
      <div className="sticky top-12 flex h-[calc(100dvh-3rem)] flex-col gap-0.5 overflow-y-auto px-3 py-4">
        <p className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">{app.label}</p>
        {items.map(({ href, label, icon: Icon }) => {
          const active = activeHref === href;
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
              {active ? (
                <span aria-hidden className="bg-app-accent absolute inset-y-1 -left-3 w-px" />
              ) : null}
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
