"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { cn } from "cn";
import {
  destinationForPath,
  destinations,
  homeHref,
  type Destination,
} from "@/lib/navigation";

/*
 * The shell's left rail: the Polymath wordmark, then one flat list of the
 * product's destinations. There is no app layer to switch between, so no
 * identity header per app and no launcher entry — everything on screen is
 * Polymath. Shared workspace services (Reviews, Activity, Settings) sit at
 * the bottom. Collapses to an icon rail; the choice persists in localStorage.
 *
 * No count badges: the only counts chrome can read without a server
 * round-trip come from the browser-preview store, and the rail's pages read
 * canonical Postgres records - a badge from one source over a page fed by
 * another is a number that lies (ASH-164).
 */

const COLLAPSED_KEY = "axiom-sidenav-collapsed";
const subscribeToHydration = () => () => {};

export function SideNav() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSED_KEY) !== "1") return;
    const frame = requestAnimationFrame(() => setCollapsed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  function toggle() {
    setCollapsed((current) => {
      window.localStorage.setItem(COLLAPSED_KEY, current ? "0" : "1");
      return !current;
    });
  }

  function openCommand() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  }

  const activeHref = destinationForPath(pathname)?.href;

  function itemLink(destination: Destination) {
    const active = activeHref === destination.href;
    return (
      <Link
        key={destination.href}
        href={destination.href}
        prefetch={true}
        aria-label={destination.label}
        title={collapsed ? destination.label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 min-h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          collapsed ? "justify-center px-0" : "px-2.5",
          active
            ? "bg-sidebar-accent text-sidebar-foreground font-medium"
            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        )}
      >
        <destination.icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-75")} />
        {collapsed ? null : <span className="min-w-0 flex-1 truncate">{destination.label}</span>}
      </Link>
    );
  }

  return (
    <nav
      aria-label="Workspace"
      className={cn(
        "border-sidebar-border bg-sidebar sticky top-0 hidden h-dvh shrink-0 border-r md:block",
        collapsed ? "w-[52px]" : "w-60",
      )}
    >
      <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-2.5">
        <Link
          href={homeHref}
          className={cn(
            "text-sidebar-foreground hover:bg-sidebar-accent flex h-9 items-center gap-2 rounded-md text-[13px] font-semibold tracking-tight transition-colors outline-none",
            "focus-visible:ring-ring focus-visible:ring-3",
            collapsed ? "justify-center px-0" : "px-2",
          )}
        >
          <span aria-hidden className="polymath-mark !size-6 !text-[15px]">P</span>
          {collapsed ? null : <span className="min-w-0 flex-1 truncate text-left">Polymath</span>}
        </Link>

        <span className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={openCommand}
          disabled={!hydrated}
          aria-label="Search workspace"
          data-search-trigger
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            "border-sidebar-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-50 flex h-8 flex-1 items-center gap-2.5 rounded-md border text-[13px] transition-colors outline-none",
            "focus-visible:ring-ring focus-visible:ring-3",
            collapsed ? "justify-center border-transparent bg-transparent px-0 hover:bg-sidebar-accent" : "px-2.5",
          )}
        >
          <Search aria-hidden className="size-4 shrink-0" />
          {collapsed ? null : (
            <>
              <span className="flex-1 text-left">Search</span>
            </>
          )}
        </button>
        {collapsed ? null : <kbd aria-hidden className="readout text-[11px]">⌘K</kbd>}
        </span>

        {/* The product's destinations, one list. */}
        <div className="mt-2 flex flex-1 flex-col gap-px">
          <div className="flex flex-col gap-px">{destinations.filter((d) => d.group !== "shared").map(itemLink)}</div>
        </div>

        {/* Shared workspace services and the collapse control, at the foot. */}
        <div className="mt-auto flex flex-col gap-0.5 pt-2">
          <div aria-hidden className="border-sidebar-border mx-2 mb-1 border-t" />
          <div className="flex flex-col gap-px">{destinations.filter((d) => d.group === "shared").map(itemLink)}</div>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground mt-1 flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              collapsed ? "justify-center px-0" : "px-2.5",
            )}
          >
            {collapsed ? <ChevronsRight aria-hidden className="size-4 shrink-0" /> : <ChevronsLeft aria-hidden className="size-4 shrink-0" />}
            {collapsed ? null : <span>Collapse</span>}
          </button>
        </div>
      </div>
    </nav>
  );
}
