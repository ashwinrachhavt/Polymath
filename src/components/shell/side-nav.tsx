"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { ChevronsLeft, ChevronsRight, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "cn";
import {
  additionalDestinationsIn,
  appForPath,
  apps,
  destinationForPath,
  destinationsIn,
  type Destination,
} from "@/lib/navigation";
import { useWorkspace } from "@/components/workspace/workspace-provider";

/*
 * The shell's left rail, GSuite-style: a product picker anchored at the top
 * left (the active product's icon and name, opening a grid of all three
 * products), and under it the feature sidebar for the product you are in.
 * Shared workspace services (Reviews, Activity, Settings) sit at the bottom.
 * Collapses to an icon rail; the choice persists in localStorage.
 *
 * Count badges come from the browser-preview workspace state, the only
 * counts available to chrome without a server round-trip.
 */

const COLLAPSED_KEY = "axiom-sidenav-collapsed";

export function SideNav() {
  const pathname = usePathname();
  const { state } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

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
  const badges: Partial<Record<string, number>> = {
    "/command-center/inbox": state.captures.filter((capture) => capture.status === "UNPROCESSED").length,
    "/command-center/relationships": state.contacts.length,
    "/command-center/opportunities": state.opportunities.length,
    "/neuralflow/work": state.tasks.length,
    "/alfred/knowledge": state.artifacts.length,
  };

  const PickerIcon = activeApp?.icon;

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
        {/* The product picker: the top-left anchor. Shows the active product
            and opens a grid of all three, GSuite-style. */}
        <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Popover.Trigger
            aria-label="Switch product"
            className={cn(
              "text-sidebar-foreground hover:bg-sidebar-accent flex h-9 items-center gap-2 rounded-md text-[13px] font-semibold tracking-tight transition-colors outline-none",
              "focus-visible:ring-ring focus-visible:ring-3 data-[state=open]:bg-sidebar-accent",
              collapsed ? "justify-center px-0" : "px-2",
            )}
          >
            {PickerIcon ? (
              <span className="product-mark !size-6 !rounded-[5px]"><PickerIcon aria-hidden className="size-3.5" /></span>
            ) : (
              <span aria-hidden className="axiom-mark !size-6 !text-[15px]">A</span>
            )}
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1 truncate text-left">{activeApp?.label ?? "Axiom"}</span>
                <ChevronsUpDown aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              </>
            )}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="panel bg-popover text-popover-foreground z-50 w-[268px] rounded-xl p-2 shadow-raised outline-none"
            >
              <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px] font-medium uppercase tracking-wider">Products</p>
              <div className="grid grid-cols-3 gap-1">
                {apps.map(({ slug, label, question, href, icon: Icon }) => {
                  const active = activeApp?.slug === slug;
                  return (
                    <Link
                      key={slug}
                      href={href}
                      onClick={() => setPickerOpen(false)}
                      aria-current={active ? "true" : undefined}
                      title={question}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-center outline-none",
                        "hover:bg-accent focus-visible:ring-ring focus-visible:ring-3",
                        active ? "bg-accent text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="product-mark !size-8"><Icon aria-hidden className="size-4" /></span>
                      <span className="text-[11px] leading-tight font-medium">{label}</span>
                    </Link>
                  );
                })}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

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
                    <p className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider">Preview tools</p>
                  )}
                  <div className="flex flex-col gap-px opacity-80">{additionalDestinationsIn(activeApp.slug).map(itemLink)}</div>
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
