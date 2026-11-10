"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, PanelLeftOpen, Pin, Search } from "lucide-react";
import { cn } from "cn";
import { OPEN_COMMAND_SEARCH } from "./command-layer-mount";
import { destinationForPath, destinations, homeHref, isConversationSurface, type Destination } from "@/lib/navigation";
import { readPinned, subscribeToPin, writePinned } from "@/lib/sidebar-pin";

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
 *
 * On a focus page (isFocusSurface) the rail gets out of the way: it waits
 * off-canvas, a 12px zone at the left edge slides it in over the page, and
 * it hides 250ms after the pointer leaves. A button at the top left, `[`, or
 * the pin control inside the rail pins it open again; the button is the way
 * in for touch (no hover zone) and keyboard (a hidden rail is inert). The pin
 * persists in this browser (lib/sidebar-pin.ts), mirrored onto <html> so a
 * pinned rail is laid out from the first paint. data-state names which of
 * the four states is on screen: docked, hidden, peek or pinned.
 */

const COLLAPSED_KEY = "axiom-sidenav-collapsed";
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

export function SideNav({ focus = false }: { focus?: boolean }) {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  // A conversation surface owns the width: the rail folds to its icon state
  // while one is live on it. A person who pinned the rail open (localStorage
  // "0") keeps it open; the auto-collapse does not fight them.
  const isConversation = isConversationSurface(pathname);
  const [collapsed, setCollapsed] = useState(false);
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

  const state = !focus ? "docked" : pinned ? "pinned" : peeking ? "peek" : "hidden";
  const overlay = state === "hidden" || state === "peek";
  // The icon rail is a docked-page preference; a focus page's rail is either
  // out of the way or pinned at full width.
  const iconRail = state === "docked" && collapsed;

  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSED_KEY) !== "1") return;
    const frame = requestAnimationFrame(() => setCollapsed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!isConversation || focus) return;
    const frame = requestAnimationFrame(() => {
      if (window.localStorage.getItem(COLLAPSED_KEY) !== "0") setCollapsed(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [isConversation, focus]);

  useEffect(() => {
    if (!focus) return;
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
  }, [focus]);

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

  function toggle() {
    setCollapsed((current) => {
      window.localStorage.setItem(COLLAPSED_KEY, current ? "0" : "1");
      return !current;
    });
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
        title={iconRail ? destination.label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 min-h-8 items-center gap-2.5 rounded-md text-body-dense transition-colors outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          iconRail ? "justify-center px-0" : "px-2.5",
          active
            ? "bg-sidebar-accent text-sidebar-foreground font-medium"
            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        )}
      >
        <destination.icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-75")} />
        {iconRail ? null : <span className="min-w-0 flex-1 truncate">{destination.label}</span>}
      </Link>
    );
  }

  return (
    <>
      {/* The edge zone sits under the rail, so a peeking rail covers it.
          Hover only exists for a fine pointer; touch never gets the zone. */}
      {focus && !pinned ? (
        <div
          data-peek-zone
          aria-hidden
          onMouseEnter={showPeek}
          className="sidebar-pinned:hidden fixed inset-y-0 left-0 z-40 hidden w-3 pointer-fine:md:block"
        />
      ) : null}
      {/* The way back to the rail for touch and keyboard, at the top left.
          A peeking rail (z-40) covers it. Below md the bottom bar is the
          navigation and the rail never shows, so neither does this. */}
      {focus && !pinned ? (
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
      {/* Hovering a docked rail also counts as a peek: following one of its
          links into a focus page leaves the rail under the pointer until the
          pointer leaves it. */}
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
          "group/nav border-sidebar-border bg-sidebar hidden h-dvh shrink-0 border-r md:block",
          overlay
            ? "fixed inset-y-0 left-0 z-40 shadow-[var(--shadow)] transition-transform duration-200 ease-out motion-reduce:transition-none"
            : "sticky top-0",
          state === "hidden" && "-translate-x-full",
          // Server markup is always "hidden" (it cannot read the pin). For a
          // pinned person <html data-sidebar-pinned> lays it out as the pinned
          // rail until hydration swaps in the real state: no shift.
          state === "hidden" &&
            "sidebar-pinned:sticky sidebar-pinned:bottom-auto sidebar-pinned:z-auto sidebar-pinned:translate-x-0 sidebar-pinned:shadow-none",
          iconRail ? "w-[52px]" : "w-60",
        )}
      >
        <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-2.5">
          {/*
           * The mark and the disclosure share one row in both states, so the
           * chevron sits where the eye already is. A 52px rail cannot hold a 24px
           * mark and a 24px target inside the 8px gutter, so the collapsed row
           * borrows the gutter back rather than shrinking the target below the
           * 24px floor in agents/design.md.
           */}
          <div className={cn("flex items-center", iconRail ? "-mx-1.5" : "gap-1")}>
            {/* axe's label-content-name-mismatch: when an aria-label is present,
              the link's text content must appear inside it. The mark's "P" is
              aria-hidden for painting but still counts as text content here, so
              any aria-label ("Polymath", "Polymath home") fails the rule. No
              label: the visible "Polymath" names the link, and the title covers
              the collapsed state where the text is not rendered. */}
            <Link
              href={homeHref}
              title={iconRail ? "Polymath" : undefined}
              className={cn(
                "text-sidebar-foreground hover:bg-sidebar-accent flex items-center gap-2 rounded-md text-body-dense font-semibold tracking-tight transition-colors outline-none",
                "focus-visible:ring-ring focus-visible:ring-3",
                iconRail ? "size-6 justify-center px-0" : "h-9 min-w-0 flex-1 px-2",
              )}
            >
              <span aria-hidden className="polymath-mark !size-6 !text-body">
                P
              </span>
              {iconRail ? null : <span className="min-w-0 flex-1 truncate text-left">Polymath</span>}
            </Link>
            {/*
             * aria-expanded reports the rail, the label reports the action: a
             * name that restates the current state ("Collapsed") tells a screen
             * reader where it is, not what pressing the button does.
             *
             * Invisible until hover: the collapse control is chrome, not content,
             * so it stays out of the rail's reading order until the pointer is
             * over the rail. Keyboard focus and the expanded state keep it
             * visible (focus-visible for keyboard, aria-expanded for the state);
             * on touch there is no hover, so the expanded rail keeps its opacity
             * and the collapsed rail shows the expand arrow outright.
             */}
            {focus ? (
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
            ) : (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={!collapsed}
                aria-label={iconRail ? "Expand navigation" : "Collapse navigation"}
                title={iconRail ? "Expand navigation" : "Collapse navigation"}
                className={cn(
                  "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground flex shrink-0 items-center justify-center rounded-md transition-colors outline-none",
                  "focus-visible:ring-ring focus-visible:ring-3",
                  // Always visible: the rail's only persistent control. Auto-collapse
                  // made hidden-when-collapsed reachable on its own, and a hover-reveal
                  // control is undiscoverable on touch and indistinguishable from an
                  // unsettled animation to the e2e settle gate.
                  "opacity-100",
                  iconRail ? "size-6" : "size-8",
                )}
              >
                {iconRail ? (
                  <ChevronsRight aria-hidden className="size-4" />
                ) : (
                  <ChevronsLeft aria-hidden className="size-4" />
                )}
              </button>
            )}
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
                "border-sidebar-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-50 flex h-8 flex-1 items-center gap-2.5 rounded-md border text-body-dense transition-colors outline-none",
                "focus-visible:ring-ring focus-visible:ring-3",
                iconRail ? "justify-center border-transparent bg-transparent px-0 hover:bg-sidebar-accent" : "px-2.5",
              )}
            >
              <Search aria-hidden className="size-4 shrink-0" />
              {iconRail ? null : (
                <>
                  <span className="flex-1 text-left">Search</span>
                </>
              )}
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
