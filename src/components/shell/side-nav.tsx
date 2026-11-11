"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftOpen, Pin, Search } from "lucide-react";
import { cn } from "cn";
import { OPEN_COMMAND_SEARCH } from "./command-layer-mount";
import { destinationForPath, destinations, homeHref, type Destination } from "@/lib/navigation";
import { readPinned, subscribeToPin, writePinned } from "@/lib/sidebar-pin";

/*
 * The shell's left rail: the Polymath wordmark, then one flat list of the
 * product's destinations. There is no app layer to switch between, so no
 * identity header per app and no launcher entry — everything on screen is
 * Polymath. Shared workspace services (Reviews, Activity, Settings) sit at
 * the bottom.
 *
 * No count badges: the only counts chrome can read without a server
 * round-trip come from the browser-preview store, and the rail's pages read
 * canonical Postgres records - a badge from one source over a page fed by
 * another is a number that lies (ASH-164).
 *
 * Every page shares one rail. It is pinned open, or it waits off-canvas: a
 * 12px zone at the left edge slides it in over the page, and it hides 250ms
 * after the pointer leaves. A button at the top left, `[`, or the pin control
 * inside the rail toggles the pin; the button is the way in for touch (no
 * hover zone) and keyboard (a hidden rail is inert). The pin persists in this
 * browser (lib/sidebar-pin.ts), mirrored onto <html> so a pinned rail is laid
 * out from the first paint. data-state names which of the three states is on
 * screen: hidden, peek or pinned.
 */

const PEEK_HIDE_DELAY_MS = 250;
const subscribeToHydration = () => () => {};

/** `[` is a character while the person is writing, a shortcut otherwise. */
function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    (target.matches("input, textarea, select") ||
      target.closest("[contenteditable]:not([contenteditable='false'])") !== null)
  );
}

/** True when keyboard focus sits inside `element`. */
function holdsFocus(element: HTMLElement | null) {
  return element?.contains(document.activeElement) ?? false;
}

export function SideNav() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const pinned = useSyncExternalStore(subscribeToPin, readPinned, () => false);
  const [peeking, setPeeking] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const navRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const pinRef = useRef<HTMLButtonElement>(null);
  // A mouse or pen over the rail. Touch has no hover, and a keyboard user's
  // pointer can be anywhere, so neither counts as "on the rail".
  const pointerOnRail = useRef(false);
  // Pinning removes the opener, and unpinning hides the rail (inert): either
  // way the focused control leaves, and focus would fall to <body>. It moves
  // to the control that toggles back instead.
  const handOffFocus = useRef(false);

  const state = pinned ? "pinned" : peeking ? "peek" : "hidden";
  const overlay = state !== "pinned";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      window.clearTimeout(hideTimer.current);
      setPeeking(false);
      const pin = !readPinned();
      handOffFocus.current = holdsFocus(pin ? openerRef.current : navRef.current);
      writePinned(pin);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useLayoutEffect(() => {
    if (!handOffFocus.current) return;
    handOffFocus.current = false;
    if (state === "hidden") openerRef.current?.focus();
    if (state === "pinned") pinRef.current?.focus();
  }, [state]);

  function showPeek() {
    window.clearTimeout(hideTimer.current);
    setPeeking(true);
  }

  function hidePeekSoon() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPeeking(false), PEEK_HIDE_DELAY_MS);
  }

  // Unpinning with a mouse on the rail keeps it as a peek that hides when
  // the pointer leaves, like any other peek. Unpinning by keyboard or touch
  // hides it at once: no mouseleave would ever come to hide a peek.
  function togglePin() {
    window.clearTimeout(hideTimer.current);
    const keepPeek = pinned && pointerOnRail.current;
    setPeeking(keepPeek);
    handOffFocus.current = !keepPeek && holdsFocus(pinned ? navRef.current : openerRef.current);
    writePinned(!pinned);
  }

  function openCommand() {
    window.dispatchEvent(new Event(OPEN_COMMAND_SEARCH));
  }

  const activeHref = destinationForPath(pathname)?.href;

  function itemLink(destination: Destination) {
    const active = activeHref === destination.href;
    return (
      <Link
        key={destination.href}
        href={destination.href}
        aria-label={destination.label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 min-h-8 items-center gap-2.5 rounded-md px-2.5 text-body-dense transition-colors outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          active
            ? "bg-sidebar-accent text-sidebar-foreground font-medium"
            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        )}
      >
        <destination.icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-75")} />
        <span className="min-w-0 flex-1 truncate">{destination.label}</span>
      </Link>
    );
  }

  return (
    <>
      {/* The edge zone sits under the rail, so a peeking rail covers it.
          Hover only exists for a fine pointer; touch never gets the zone. */}
      {!pinned ? (
        <div
          data-peek-zone
          aria-hidden
          onMouseEnter={showPeek}
          className="sidebar-pinned:hidden fixed inset-y-0 left-0 z-40 hidden w-3 pointer-fine:md:block"
        />
      ) : null}
      {/* The way back to the rail for touch and keyboard, at the top left;
          the top bar leaves room for it (top-bar.tsx). A
          peeking rail (z-40) covers it. Below md the bottom bar is the
          navigation and the rail never shows, so neither does this. */}
      {!pinned ? (
        <button
          ref={openerRef}
          type="button"
          onClick={togglePin}
          aria-keyshortcuts="["
          aria-label="Show sidebar"
          title="Show sidebar ([)"
          data-sidebar-opener
          className={cn(
            "sidebar-pinned:hidden border-border bg-background/90 text-muted-foreground hover:bg-accent hover:text-foreground fixed top-2 left-2 z-30 hidden size-8 items-center justify-center rounded-md border transition-colors outline-none md:flex",
            "focus-visible:ring-ring focus-visible:ring-3",
          )}
        >
          <PanelLeftOpen aria-hidden className="size-4" />
        </button>
      ) : null}
      {/* Hovering the rail also counts as a peek: following one of its links
          leaves the rail under the pointer until the pointer leaves it. */}
      <nav
        ref={navRef}
        aria-label="Workspace"
        data-state={state}
        inert={state === "hidden"}
        onMouseEnter={showPeek}
        onMouseLeave={hidePeekSoon}
        onPointerEnter={(event) => {
          pointerOnRail.current = event.pointerType !== "touch";
        }}
        onPointerLeave={() => {
          pointerOnRail.current = false;
        }}
        className={cn(
          "group/nav border-sidebar-border bg-sidebar hidden h-dvh w-60 shrink-0 border-r md:block",
          overlay
            ? "fixed inset-y-0 left-0 z-40 shadow-[var(--shadow)] transition-transform duration-200 ease-out motion-reduce:transition-none"
            : "sticky top-0",
          state === "hidden" && "-translate-x-full",
          // Server markup is always "hidden" (it cannot read the pin). For a
          // pinned person <html data-sidebar-pinned> lays it out as the pinned
          // rail until hydration swaps in the real state: no shift.
          state === "hidden" &&
            "sidebar-pinned:sticky sidebar-pinned:bottom-auto sidebar-pinned:z-auto sidebar-pinned:translate-x-0 sidebar-pinned:shadow-none",
        )}
      >
        <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-2.5">
          <div className="flex items-center gap-1">
            {/* axe's label-content-name-mismatch: when an aria-label is present,
              the link's text content must appear inside it. The mark's "P" is
              aria-hidden for painting but still counts as text content here, so
              any aria-label ("Polymath", "Polymath home") fails the rule. No
              label: the visible "Polymath" names the link. */}
            <Link
              href={homeHref}
              className={cn(
                "text-sidebar-foreground hover:bg-sidebar-accent flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body-dense font-semibold tracking-tight transition-colors outline-none",
                "focus-visible:ring-ring focus-visible:ring-3",
              )}
            >
              <span aria-hidden className="polymath-mark !size-6 !text-body">
                P
              </span>
              <span className="min-w-0 flex-1 truncate text-left">Polymath</span>
            </Link>
            <button
              ref={pinRef}
              type="button"
              onClick={togglePin}
              aria-pressed={pinned}
              aria-keyshortcuts="["
              aria-label="Keep sidebar open"
              title="Keep sidebar open ([)"
              className={cn(
                "hover:bg-sidebar-accent hover:text-sidebar-foreground flex size-8 shrink-0 items-center justify-center rounded-md transition-colors outline-none",
                "focus-visible:ring-ring focus-visible:ring-3",
                pinned ? "bg-sidebar-accent text-sidebar-foreground" : "text-muted-foreground",
              )}
            >
              <Pin aria-hidden className="size-4" />
            </button>
          </div>

          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={openCommand}
              disabled={!hydrated}
              aria-label="Search workspace"
              data-search-trigger
              aria-keyshortcuts="Meta+K Control+K"
              className={cn(
                "border-sidebar-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-50 flex h-8 flex-1 items-center gap-2.5 rounded-md border px-2.5 text-body-dense transition-colors outline-none",
                "focus-visible:ring-ring focus-visible:ring-3",
              )}
            >
              <Search aria-hidden className="size-4 shrink-0" />
              <span className="flex-1 text-left">Search</span>
            </button>
          </span>

          {/* The product's destinations, one list. Default prefetch: with
            partialPrefetching each destination's App Shell is fetched once and
            shared. prefetch={true} would add a per-link server render for URL
            data none of these rail links carry. */}
          <div className="mt-2 flex flex-1 flex-col gap-px">
            <div className="flex flex-col gap-px">{destinations.filter((d) => d.group !== "shared").map(itemLink)}</div>
          </div>

          {/* Shared workspace services, at the foot. */}
          <div className="mt-auto flex flex-col gap-0.5 pt-2">
            <div aria-hidden className="border-sidebar-border mx-2 mb-1 border-t" />
            <div className="flex flex-col gap-px">{destinations.filter((d) => d.group === "shared").map(itemLink)}</div>
          </div>
        </div>
      </nav>
    </>
  );
}
