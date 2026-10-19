"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { Grip } from "lucide-react";
import { cn } from "cn";
import { CoachMark } from "@/components/shell/coach-mark";
import { apps, appForPath, crossAppLinksFrom } from "@/lib/navigation";

/*
 * The app launcher: the suite's only global switcher, top right next to the
 * account menu, Google-apps-style. One grid icon opens a panel of the three
 * apps; nothing about app switching lives in any app's own nav.
 *
 * The distinction is the whole point of this component. Each app owns its own
 * nav bar and its own personality; this grid is the *only* global chrome, so an
 * app's nav can look like whatever that app needs without the shell flattening
 * all three into one list.
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
      <span className="relative inline-flex">
      <Popover.Trigger
        aria-label="Open apps"
        title="Apps"
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
        )}
      >
        <Grip aria-hidden className="size-4" />
      </Popover.Trigger>
      <CoachMark id="launcher-top-right" title="Products have a new home">
        Switch between Command Center, NeuralFlow and Alfred right here.
      </CoachMark>
      </span>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="panel bg-popover text-popover-foreground shadow-raised z-50 w-[284px] rounded-xl p-2 outline-none"
        >
          <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px] font-medium uppercase tracking-wider">Apps</p>
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
                    "flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-center outline-none",
                    "hover:bg-accent focus-visible:ring-ring focus-visible:ring-3",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span
                    className="product-mark !size-9"
                    style={
                      active
                        ? ({ "--app-accent": `var(--accent-${slug})` } as React.CSSProperties)
                        : undefined
                    }
                  >
                    <Icon aria-hidden className={cn("size-4", active && "text-app-accent")} />
                  </span>
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
 * this glyph represents. Each active glyph re-points `--app-accent` at its own
 * app's `--accent-<slug>` variable (declared in globals.css next to the data-app
 * scopes) so the hue has one source of truth and no inline oklch here.
 */
