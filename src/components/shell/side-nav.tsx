"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Menu, PanelLeft, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { cn } from "cn";
import { OPEN_COMMAND_SEARCH } from "./command-layer-mount";
import { WorkspaceSwitcher, type WorkspaceSwitcherData } from "@/components/shell/workspace-switcher";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip } from "@/components/ui/tooltip";
import { destinationForPath, destinations, homeHref, type Destination } from "@/lib/navigation";
import {
  mirrorClosedGroups,
  mirrorPinned,
  readClosedGroups,
  readPinned,
  subscribeToSidebar,
  writeGroupClosed,
  writePinned,
  type SidebarGroupId,
} from "@/lib/sidebar-pin";

/*
 * The shell's left rail, in Linear's manner: the workspace at the top with
 * the collapse control, Search as a command row, then the destinations in two
 * foldable groups (the product's own, then the shared workspace services).
 * Every destination stays; nothing here decides what the product contains.
 *
 * Three states are on screen at any time, named by data-state: pinned (docked
 * beside the page), peek (floating over it while the pointer rests on the left
 * edge or the rail), and hidden. One control moves between pinned and the
 * rest: the button in the rail's header, the opener at the top left when it
 * is hidden, and `[`. The choice is remembered in this browser and mirrored
 * onto <html> so a docked rail is laid out from the first paint
 * (lib/sidebar-pin.ts). Ordinary pages start open and focus surfaces such as
 * Notes start closed; each remembers its own choice, so opening the rail on
 * Notes works and does not dock it on the inbox.
 *
 * Under md there is no docked rail: the opener at the top left opens the same
 * content as a drawer.
 *
 * No count badges: the only counts chrome can read without a server
 * round-trip come from the browser-preview store, and the rail's pages read
 * canonical Postgres records - a badge from one source over a page fed by
 * another is a number that lies (ASH-164).
 */

const PEEK_HIDE_DELAY_MS = 250;
const subscribeToHydration = () => () => {};

const GROUPS: { id: SidebarGroupId; label: string; shared: boolean }[] = [
  { id: "main", label: "Workspace", shared: false },
  { id: "shared", label: "Manage", shared: true },
];

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

const controlClass =
  "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-ring focus-visible:ring-3";

export function SideNav({
  focusSurface = false,
  workspaceSwitcher = null,
}: {
  focusSurface?: boolean;
  workspaceSwitcher?: WorkspaceSwitcherData | null;
}) {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const pinned = useSyncExternalStore(
    subscribeToSidebar,
    () => readPinned(focusSurface),
    () => false,
  );
  const closedKey = useSyncExternalStore(
    subscribeToSidebar,
    () => readClosedGroups().join(" "),
    () => "",
  );
  const closedGroups = closedKey.split(" ");
  const [peeking, setPeeking] = useState(false);
  // The drawer is open for the page it was opened on, so following one of its
  // links (a new pathname) shuts it without an effect.
  const [drawerFor, setDrawerFor] = useState<string | null>(null);
  const drawerOpen = drawerFor === pathname;
  const hideTimer = useRef<number | undefined>(undefined);
  const navRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  // A mouse or pen over the rail. Touch has no hover, and a keyboard user's
  // pointer can be anywhere, so neither counts as "on the rail".
  const pointerOnRail = useRef(false);
  // Collapsing removes the collapse control and expanding removes the opener:
  // either way the focused control leaves, and focus would fall to <body>. It
  // moves to the control that toggles back instead.
  const handOffFocus = useRef(false);

  const state = pinned ? "pinned" : peeking ? "peek" : "hidden";
  const overlay = !pinned;

  // <html> follows the real choice once it is known (never from the server's
  // placeholder, which would undo what the boot script painted).
  useLayoutEffect(() => {
    if (hydrated) mirrorPinned(pinned);
  }, [hydrated, pinned]);
  useLayoutEffect(() => {
    if (hydrated) mirrorClosedGroups(readClosedGroups());
  }, [hydrated, closedKey]);

  function toggle() {
    window.clearTimeout(hideTimer.current);
    // Collapsing with a mouse on the rail keeps it as a peek that hides when
    // the pointer leaves, like any other peek. Collapsing by keyboard or
    // touch hides it at once: no mouseleave would ever come to hide a peek.
    const keepPeek = pinned && pointerOnRail.current;
    setPeeking(keepPeek);
    handOffFocus.current = !keepPeek && holdsFocus(pinned ? navRef.current : openerRef.current);
    const next = !pinned;
    writePinned(focusSurface, next);
    mirrorPinned(next);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      window.clearTimeout(hideTimer.current);
      setPeeking(false);
      const next = !readPinned(focusSurface);
      handOffFocus.current = holdsFocus(next ? openerRef.current : navRef.current);
      writePinned(focusSurface, next);
      mirrorPinned(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSurface]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useLayoutEffect(() => {
    if (!handOffFocus.current) return;
    handOffFocus.current = false;
    if (state === "hidden") openerRef.current?.focus();
    if (state === "pinned") collapseRef.current?.focus();
  }, [state]);

  function showPeek() {
    window.clearTimeout(hideTimer.current);
    setPeeking(true);
  }

  function hidePeekSoon() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPeeking(false), PEEK_HIDE_DELAY_MS);
  }

  function openCommand() {
    window.dispatchEvent(new Event(OPEN_COMMAND_SEARCH));
  }

  function toggleGroup(id: SidebarGroupId) {
    writeGroupClosed(id, !readClosedGroups().includes(id));
    mirrorClosedGroups(readClosedGroups());
  }

  /** Up and Down walk the rail's controls, Home and End jump to its ends. */
  function onRailKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
    // A folded group's links are display:none (globals.css), so they leave the walk.
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter(
      (element) => {
        const body = element.closest("[data-sidebar-group-body]");
        const owner = body?.closest("[data-sidebar-group]")?.getAttribute("data-sidebar-group");
        return !owner || !closedGroups.includes(owner);
      },
    );
    if (controls.length === 0) return;
    const current = controls.indexOf(document.activeElement as HTMLElement);
    const last = controls.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? Math.min(current + 1, last)
            : Math.max(current - 1, 0);
    event.preventDefault();
    controls[next]?.focus();
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
          "flex h-7 items-center gap-2.5 rounded-md px-2 text-body-dense transition-colors outline-none",
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

  function group({ id, label, shared }: (typeof GROUPS)[number]) {
    const closed = closedGroups.includes(id);
    return (
      <div key={id} data-sidebar-group={id} className="flex flex-col gap-px">
        <button
          type="button"
          onClick={() => toggleGroup(id)}
          aria-expanded={!closed}
          className={cn(
            "text-muted-foreground hover:text-sidebar-foreground group/head flex h-6 items-center gap-1 rounded-md px-2 text-data outline-none",
            "focus-visible:ring-ring focus-visible:ring-3",
          )}
        >
          <span>{label}</span>
          <ChevronDown
            aria-hidden
            data-sidebar-chevron
            className="size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 group-hover/head:opacity-100 group-focus-visible/head:opacity-100"
          />
        </button>
        <div data-sidebar-group-body className="flex flex-col gap-px">
          {destinations.filter((destination) => (destination.group === "shared") === shared).map(itemLink)}
        </div>
      </div>
    );
  }

  const searchRow = (
    <button
      type="button"
      onClick={openCommand}
      disabled={!hydrated}
      aria-label="Search workspace"
      data-search-trigger
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "border-sidebar-border bg-card text-muted-foreground hover:text-foreground flex h-7 w-full items-center gap-2.5 rounded-md border px-2 text-body-dense transition-colors outline-none disabled:opacity-50",
        "focus-visible:ring-ring focus-visible:ring-3",
      )}
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="flex-1 text-left">Search</span>
      {/* Generated content, not text: the accessible name stays "Search workspace". */}
      <kbd aria-hidden className="text-data font-sans before:content-['⌘K']" />
    </button>
  );

  /* axe's label-content-name-mismatch: when an aria-label is present, the
     link's text content must appear inside it. The mark's "P" is aria-hidden
     for painting but still counts as text content here, so the wordmark link
     carries no aria-label: the visible "Polymath" names it. */
  const workspaceRow = workspaceSwitcher ? (
    <WorkspaceSwitcher data={workspaceSwitcher} rail />
  ) : (
    <Link
      href={homeHref}
      className={cn(
        "text-sidebar-foreground hover:bg-sidebar-accent flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body-dense font-semibold tracking-tight transition-colors outline-none",
        "focus-visible:ring-ring focus-visible:ring-3",
      )}
    >
      <span aria-hidden className="polymath-mark !size-5 !text-data">
        P
      </span>
      <span className="min-w-0 flex-1 truncate text-left">Polymath</span>
    </Link>
  );

  function railBody(header: ReactNode) {
    return (
      <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-2" onKeyDown={onRailKeyDown}>
        <div className="flex items-center gap-1">
          {workspaceRow}
          {header}
        </div>
        {searchRow}
        {/* The product's destinations. Default prefetch: with partialPrefetching
            each destination's App Shell is fetched once and shared.
            prefetch={true} would add a per-link server render for URL data
            none of these rail links carry. */}
        <div className="mt-2 flex flex-col gap-2">{GROUPS.filter((entry) => !entry.shared).map(group)}</div>
        <div className="mt-auto flex flex-col gap-2 pt-2">
          <div aria-hidden className="border-sidebar-border mx-2 border-t" />
          {GROUPS.filter((entry) => entry.shared).map(group)}
        </div>
      </div>
    );
  }

  const collapseLabel = pinned ? "Collapse sidebar" : "Keep sidebar open";

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
      {/* The way back to the rail for touch and keyboard, at the top left; the
          top bar leaves room for it (top-bar.tsx). A peeking rail (z-40)
          covers it. */}
      {!pinned ? (
        <Tooltip content="Show sidebar" shortcut="[" side="right">
          <button
            ref={openerRef}
            type="button"
            onClick={toggle}
            aria-keyshortcuts="["
            aria-label="Show sidebar"
            data-sidebar-opener
            className={cn(
              "sidebar-pinned:hidden border-border bg-background/90 text-muted-foreground hover:bg-accent hover:text-foreground fixed top-2 left-2 z-30 hidden size-8 items-center justify-center rounded-md border transition-colors outline-none md:flex",
              "focus-visible:ring-ring focus-visible:ring-3",
            )}
          >
            <PanelLeftOpen aria-hidden className="size-4" />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip content="Open menu" side="right">
        <button
          type="button"
          onClick={() => setDrawerFor(pathname)}
          aria-label="Open menu"
          data-sidebar-drawer-opener
          className={cn(
            "border-border bg-background/90 text-muted-foreground hover:bg-accent hover:text-foreground fixed top-2 left-2 z-30 flex size-8 items-center justify-center rounded-md border transition-colors outline-none md:hidden",
            "focus-visible:ring-ring focus-visible:ring-3",
          )}
        >
          <Menu aria-hidden className="size-4" />
        </button>
      </Tooltip>

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
            ? "fixed inset-y-0 left-0 z-40 shadow-[var(--shadow)] transition-transform duration-150 ease-out motion-reduce:transition-none"
            : "sticky top-0",
          state === "hidden" && "-translate-x-full",
          // Server markup is always "hidden" (it cannot read the choice). For a
          // person who kept it open <html data-sidebar-pinned> lays it out as
          // the docked rail until hydration swaps in the real state: no shift.
          state === "hidden" &&
            "sidebar-pinned:sticky sidebar-pinned:bottom-auto sidebar-pinned:z-auto sidebar-pinned:translate-x-0 sidebar-pinned:shadow-none",
        )}
      >
        {railBody(
          <Tooltip content={collapseLabel} shortcut="[" side="bottom">
            <button
              ref={collapseRef}
              type="button"
              onClick={toggle}
              aria-keyshortcuts="["
              aria-label={collapseLabel}
              className={controlClass}
            >
              {pinned ? (
                <PanelLeftClose aria-hidden className="size-4" />
              ) : (
                <PanelLeft aria-hidden className="size-4" />
              )}
            </button>
          </Tooltip>,
        )}
      </nav>

      {/* Under md the same content opens as a drawer. */}
      <Sheet open={drawerOpen} onOpenChange={(open) => setDrawerFor(open ? pathname : null)}>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          className="bg-sidebar data-[side=left]:w-72 data-[side=left]:max-w-[85vw] data-[side=left]:sm:max-w-72 gap-0 p-0 md:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {railBody(null)}
        </SheetContent>
      </Sheet>
    </>
  );
}
