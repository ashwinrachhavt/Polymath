"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { cn } from "cn";
import {
  additionalDestinationsIn,
  apps,
  destinationForPath,
  destinationsIn,
  type AppSlug,
  type Destination,
} from "@/lib/navigation";
import { useWorkspace } from "@/components/workspace/workspace-provider";

/*
 * The Linear-style sidebar: one persistent lateral nav for the whole suite.
 * The workspace row sits on top, search under it, then one section per app
 * (Alfred, NeuralFlow, Command Center) plus the shared Workspace section.
 * It collapses to an icon rail; the choice persists in localStorage.
 *
 * Count badges come from the browser-preview workspace state, the only
 * counts available to chrome without a server round-trip.
 */

const COLLAPSED_KEY = "axiom-sidenav-collapsed";
const APP_ORDER: AppSlug[] = ["alfred", "neuralflow", "command-center"];

export function SideNav() {
  const pathname = usePathname();
  const { state } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "1");
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
  const badges: Partial<Record<string, number>> = {
    "/command-center/inbox": state.captures.filter((capture) => capture.status === "UNPROCESSED").length,
    "/command-center/relationships": state.contacts.length,
    "/command-center/opportunities": state.opportunities.length,
    "/neuralflow/work": state.tasks.length,
    "/alfred/knowledge": state.artifacts.length,
  };

  function itemLink(destination: Destination) {
    const active = activeHref === destination.href;
    const count = badges[destination.href] ?? 0;
    return (
      <Link
        key={destination.href}
        href={destination.href}
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
        {collapsed || count === 0 ? null : (
          <span className="readout rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
            {count}
          </span>
        )}
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
        <div className={cn("flex items-center gap-2 pb-1.5", collapsed ? "flex-col" : "px-1")}>
          <span aria-hidden className="axiom-mark">A</span>
          {collapsed ? null : <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">Axiom</span>}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground ml-auto flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            {collapsed ? <ChevronsRight aria-hidden className="size-3.5" /> : <ChevronsLeft aria-hidden className="size-3.5" />}
          </button>
        </div>

        <button
          type="button"
          onClick={openCommand}
          aria-label="Search workspace"
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            "border-sidebar-border bg-card text-muted-foreground hover:text-foreground flex h-8 items-center gap-2.5 rounded-md border text-[13px] transition-colors",
            collapsed ? "justify-center border-transparent bg-transparent px-0 hover:bg-sidebar-accent" : "px-2.5",
          )}
        >
          <Search aria-hidden className="size-4 shrink-0" />
          {collapsed ? null : (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="readout text-[10px]">⌘K</kbd>
            </>
          )}
        </button>

        <div className="mt-2 flex flex-col gap-4">
          {APP_ORDER.map((slug) => {
            const app = apps.find((candidate) => candidate.slug === slug);
            if (!app) return null;
            const additional = additionalDestinationsIn(app.slug);
            return (
              <div key={app.slug}>
                {collapsed ? <div aria-hidden className="border-sidebar-border mx-2 mb-1 border-t" /> : (
                  <p className="text-muted-foreground px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider">{app.label}</p>
                )}
                <div className="flex flex-col gap-px">{destinationsIn(app.slug).map(itemLink)}</div>
                {additional.length > 0 ? (
                  <div className="mt-0.5 flex flex-col gap-px opacity-75">{additional.map(itemLink)}</div>
                ) : null}
              </div>
            );
          })}
          <div>
            {collapsed ? <div aria-hidden className="border-sidebar-border mx-2 mb-1 border-t" /> : (
              <p className="text-muted-foreground px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider">Workspace</p>
            )}
            <div className="flex flex-col gap-px">{destinationsIn("shared").map(itemLink)}</div>
          </div>
        </div>
      </div>
    </nav>
  );
}
