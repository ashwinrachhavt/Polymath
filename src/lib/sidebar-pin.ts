/*
 * What the person chose about the sidebar, remembered in this browser (see
 * components/shell/side-nav.tsx): whether it is open, and which of its groups
 * are folded. Two switches, not one, because a focus surface such as Notes is
 * a different room from the rest of the app:
 *
 *   - ordinary pages: open unless the person closed it;
 *   - focus surfaces: closed unless the person opened it there.
 *
 * Closing the sidebar on Notes therefore never closes it everywhere, and
 * opening it on Notes never docks it on the inbox.
 *
 * The open state is mirrored onto <html data-sidebar-pinned> and the folded
 * groups onto <html data-sidebar-closed="main shared">, so the first paint can
 * lay the page out around the real sidebar before React reads storage: the
 * `sidebar-pinned:` variant and the group rules in globals.css key off those
 * attributes. Without them the server's markup would paint full width and then
 * narrow by the sidebar's width once the client read the choice.
 *
 * A plain module, not a client one: the root layout (a server component)
 * inlines the boot script, and a string exported from a "use client" module
 * would reach it as a client reference instead of the string.
 */

const PAGE_KEY = "polymath.sidebar.pinned";
const FOCUS_KEY = "polymath.sidebar.focus-pinned";
const GROUPS_KEY = "polymath.sidebar.closed-groups";
const PINNED_ATTRIBUTE = "data-sidebar-pinned";
const CLOSED_ATTRIBUTE = "data-sidebar-closed";

/** Routes where the page is the canvas and the sidebar starts closed. */
export const FOCUS_SURFACE_ROOTS = ["/polymath/notes"] as const;

export type SidebarGroupId = "main" | "shared";
const SIDEBAR_GROUPS: readonly SidebarGroupId[] = ["main", "shared"];

const keyFor = (focus: boolean) => (focus ? FOCUS_KEY : PAGE_KEY);

/** Ordinary pages default open, focus surfaces default closed. */
export function readPinned(focus: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(keyFor(focus));
    return stored === null ? !focus : stored === "1";
  } catch {
    return !focus;
  }
}

export function readClosedGroups(): SidebarGroupId[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(GROUPS_KEY) ?? "[]");
    return Array.isArray(parsed) ? SIDEBAR_GROUPS.filter((id) => parsed.includes(id)) : [];
  } catch {
    return [];
  }
}

/** Reflect the open state onto <html>; the layout calls it whenever the state or the route changes. */
export function mirrorPinned(pinned: boolean) {
  document.documentElement.toggleAttribute(PINNED_ATTRIBUTE, pinned);
}

export function mirrorClosedGroups(closed: readonly SidebarGroupId[]) {
  if (closed.length === 0) document.documentElement.removeAttribute(CLOSED_ATTRIBUTE);
  else document.documentElement.setAttribute(CLOSED_ATTRIBUTE, closed.join(" "));
}

/* A tiny external store over localStorage, so every reader sees a write at
   once and another tab's change arrives through "storage". The snapshots are
   a boolean and a joined string, so React can compare them by value. */
const listeners = new Set<() => void>();

export function subscribeToSidebar(listener: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== null && event.key !== PAGE_KEY && event.key !== FOCUS_KEY && event.key !== GROUPS_KEY) return;
    listener();
  }
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: there is nowhere to keep the choice, so the sidebar stays as it was.
  }
  for (const listener of listeners) listener();
}

export function writePinned(focus: boolean, pinned: boolean) {
  write(keyFor(focus), pinned ? "1" : "0");
}

export function writeGroupClosed(id: SidebarGroupId, closed: boolean) {
  const rest = readClosedGroups().filter((group) => group !== id);
  write(GROUPS_KEY, JSON.stringify(closed ? [...rest, id] : rest));
}

/* Runs in <head> before first paint. Plain ES5, no imports: it is inlined as
   a string. It picks the switch for the page being loaded, so a focus surface
   starts closed and an ordinary page starts open. Client-side navigation
   between the two re-mirrors from the layout. */
export const SIDEBAR_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,p=location.pathname,r=${JSON.stringify(
  FOCUS_SURFACE_ROOTS,
)},f=false,i;for(i=0;i<r.length;i++){if(p===r[i]||p.indexOf(r[i]+"/")===0)f=true}var v=localStorage.getItem(f?${JSON.stringify(
  FOCUS_KEY,
)}:${JSON.stringify(PAGE_KEY)});if(v===null?!f:v==="1")d.setAttribute(${JSON.stringify(
  PINNED_ATTRIBUTE,
)},"");var g=JSON.parse(localStorage.getItem(${JSON.stringify(
  GROUPS_KEY,
)})||"[]");if(Array.isArray(g)&&g.length)d.setAttribute(${JSON.stringify(CLOSED_ATTRIBUTE)},g.join(" "))}catch(e){}})();`;
