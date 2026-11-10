/*
 * Whether the person pinned the rail open on focus pages (see
 * components/shell/side-nav.tsx). The choice lives in this browser's
 * localStorage, mirrored onto <html data-sidebar-pinned> so the first paint
 * can lay the page out around a pinned rail before React reads storage: the
 * `sidebar-pinned:` variant in globals.css keys off that attribute. Without
 * it the server's "not pinned" render would paint full width and then narrow
 * by the rail's width once the client read the pin.
 *
 * A plain module, not a client one: the root layout (a server component)
 * inlines the boot script, and a string exported from a "use client" module
 * would reach it as a client reference instead of the string.
 */

const PINNED_KEY = "polymath.sidebar.pinned";
const PINNED_ATTRIBUTE = "data-sidebar-pinned";

function mirror(pinned: boolean) {
  document.documentElement.toggleAttribute(PINNED_ATTRIBUTE, pinned);
}

export function readPinned(): boolean {
  try {
    return window.localStorage.getItem(PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

/* A tiny external store over localStorage, so every reader sees a write at
   once and another tab's change arrives through "storage". */
const listeners = new Set<() => void>();

export function subscribeToPin(listener: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== PINNED_KEY && event.key !== null) return;
    mirror(readPinned());
    listener();
  }
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function writePinned(pinned: boolean) {
  mirror(pinned);
  try {
    window.localStorage.setItem(PINNED_KEY, pinned ? "1" : "0");
  } catch {
    // Blocked storage: there is nowhere to keep the pin, so the rail stays as it was.
  }
  for (const listener of listeners) listener();
}

/* Runs in <head> before first paint. Plain ES5, no imports: it is inlined as
   a string. */
export const SIDEBAR_PIN_BOOT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
  PINNED_KEY,
)})==="1")document.documentElement.setAttribute(${JSON.stringify(PINNED_ATTRIBUTE)},"");}catch(e){}})();`;
