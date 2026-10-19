"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { cn } from "cn";
import {
  additionalDestinationsIn,
  appForPath,
  destinationForPath,
  destinationsIn,
  homeHref,
  type Destination,
} from "@/lib/navigation";

/*
 * The shell's left rail: a plain identity header naming the app you are in,
 * and under it the feature sidebar for that app. App switching is global
 * chrome, so it lives in the top-right launcher, not in this rail. Shared
 * workspace services (Reviews, Activity, Settings) sit at the bottom.
 * Collapses to an icon rail; the choice persists in localStorage.
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
  const [previewOpen, setPreviewOpen] = useState(false);

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

  const activeApp = appForPath(pathname);
  const activeHref = destinationForPath(pathname)?.href;
  // Standing on a preview tool unfolds the group so the rail shows where you
  // are; anywhere else it stays folded behind its count.
  const previewActive = activeApp
    ? additionalDestinationsIn(activeApp.slug).some((destination) => destination.href === activeHref)
    : false;

  const PickerIcon = activeApp?.icon;

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
          "flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors",
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
        {/* Where you are, not a switcher: app switching lives in the
            top-right launcher, so the rail only names the current app. */}
        <Link
          href={activeApp?.href ?? homeHref}
          aria-label={activeApp ? `${activeApp.label} home` : "Axiom home"}
          className={cn(
            "text-sidebar-foreground hover:bg-sidebar-accent flex h-9 items-center gap-2 rounded-md text-[13px] font-semibold tracking-tight transition-colors outline-none",
            "focus-visible:ring-ring focus-visible:ring-3",
            collapsed ? "justify-center px-0" : "px-2",
          )}
        >
          {PickerIcon ? (
            <span className="product-mark !size-6 !rounded-[5px]"><PickerIcon aria-hidden className="size-3.5" /></span>
          ) : (
            <span aria-hidden className="axiom-mark !size-6 !text-[15px]">A</span>
          )}
          {collapsed ? null : (
            <span className="min-w-0 flex-1 truncate text-left">{activeApp?.label ?? "Axiom"}</span>
          )}
        </Link>

        <button
          type="button"
          onClick={openCommand}
          disabled={!hydrated}
          aria-label="Search workspace"
          data-search-trigger
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            "border-sidebar-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-50 flex h-8 items-center gap-2.5 rounded-md border text-[13px] transition-colors",
            collapsed ? "justify-center border-transparent bg-transparent px-0 hover:bg-sidebar-accent" : "px-2.5",
          )}
        >
          <Search aria-hidden className="size-4 shrink-0" />
          {collapsed ? null : (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="readout text-[11px]">⌘K</kbd>
            </>
          )}
        </button>

        {/* The active product's features. */}
        <div className="mt-2 flex flex-1 flex-col gap-0.5">
          {activeApp ? (
            <>
              {collapsed ? null : (
                <p className="text-muted-foreground px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider">{activeApp.label}</p>
              )}
              <div className="flex flex-col gap-px">{destinationsIn(activeApp.slug).map(itemLink)}</div>
              {additionalDestinationsIn(activeApp.slug).length > 0 ? (
                <>
                  {collapsed ? <div aria-hidden className="border-sidebar-border mx-2 my-2 border-t" /> : (
                    // The preview tools are a workshop, not the product: the
                    // group stays folded behind its count so the rail reads as
                    // the app's real pages first (ASH-168).
                    <button
                      type="button"
                      onClick={() => setPreviewOpen((open) => !open)}
                      aria-expanded={previewOpen || previewActive}
                      className="text-muted-foreground hover:text-sidebar-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 pt-3 pb-1 text-left text-[11px] font-medium uppercase tracking-wider transition-colors"
                    >
                      {previewOpen ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
                      <span>Preview tools</span>
                      <span className="readout ml-auto normal-case tracking-normal">{additionalDestinationsIn(activeApp.slug).length}</span>
                    </button>
                  )}
                  {collapsed || (!previewOpen && !previewActive) ? null : (
                    <div className="flex flex-col gap-px">{additionalDestinationsIn(activeApp.slug).map(itemLink)}</div>
                  )}
                </>
              ) : null}
            </>
          ) : null}
        </div>

        {/* Shared workspace services and the collapse control, at the foot. */}
        <div className="mt-auto flex flex-col gap-0.5 pt-2">
          {activeApp ? (
            <>
              {collapsed ? <div aria-hidden className="border-sidebar-border mx-2 mb-1 border-t" /> : (
                <p className="text-muted-foreground px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider">Workspace</p>
              )}
              <div className="flex flex-col gap-px">{destinationsIn("shared").map(itemLink)}</div>
            </>
          ) : (
            <div className="flex flex-col gap-px">{destinationsIn("shared").map(itemLink)}</div>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground mt-1 flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors",
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
