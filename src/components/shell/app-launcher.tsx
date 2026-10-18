"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { Grip } from "lucide-react";
import { cn } from "cn";
import { apps, appForPath, crossAppLinksFrom } from "@/lib/navigation";

/*
 * The app launcher, in the top bar — the Workspace model, not a switcher
 * welded into a nav rail.
 *
 * The distinction is the whole point of this component. Each app owns its own
 * nav bar and its own personality; this grid is the *only* global chrome, so an
 * app's nav can look like whatever that app needs without the shell flattening
 * all three into one list. A rail that carried the switcher would make the app
 * boundary a nav section, which is what it must not be.
 *
 * The grid also carries the cross-app links out of the current app. Those are
 * the interoperability half: they open the *other* app at the record class that
 * continues the work, so a task prepared here is finished there without being
 * copied.
 *
 * Radix Popover rather than a hand-rolled dropdown: focus trap, escape, click
 * outside, and focus-return-to-trigger all come free, and the design language
 * forbids re-implementing what a primitive already does.
 */
export function AppLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const current = appForPath(pathname);
  const outgoing = current ? crossAppLinksFrom(current.slug) : [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Open apps"
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
        )}
      >
        <Grip aria-hidden className="size-4" />
        <span className="hidden sm:inline">{current?.label ?? "Apps"}</span>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="panel bg-popover text-popover-foreground z-50 w-[268px] rounded-lg p-2 outline-none"
        >
          <div className="grid grid-cols-3 gap-1">
            {apps.map(({ slug, label, question, href, icon: Icon }) => {
              const active = current?.slug === slug;
              return (
                <Link
                  key={slug}
                  href={href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "true" : undefined}
                  title={question}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-md px-1 py-2.5 text-center outline-none",
                    "hover:bg-accent focus-visible:ring-ring focus-visible:ring-3",
                    // The current app is marked by its own accent on the glyph.
                    // No filled pill: in this direction a lit indicator means
                    // something is on, and the app you are in is.
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn("size-5", active && "text-app-accent")}
                    style={
                      active
                        ? ({ "--app-accent": `var(--accent-${slug})` } as React.CSSProperties)
                        : undefined
                    }
                  />
                  <span className="text-[11px] leading-tight font-medium">{label}</span>
                </Link>
              );
            })}
          </div>

          {outgoing.length > 0 ? (
            <>
              <div aria-hidden className="bg-border my-2 h-px" />
              <ul className="flex flex-col">
                {outgoing.map(({ label, href, to }) => (
                  <li key={`${to}-${href}`}>
                    <Link
                      href={href}
                      onClick={() => setOpen(false)}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring flex h-7 items-center rounded-md px-2 text-[13px] outline-none focus-visible:ring-3"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/*
 * The launcher sits outside any `[data-app]` scope — it is global chrome, so the
 * app-accent token it would inherit is whatever the last scope set, not the app
 * this glyph represents. Each glyph re-points `--app-accent` at its own app's
 * `--accent-<slug>` variable (declared in globals.css next to the data-app
 * scopes) so the hue has one source of truth and no inline oklch here.
 */
