"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { NoteSwitcher } from "@/components/shell/note-switcher";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { noteLayout } from "./note-layout";

/*
 * The notes page is one note column beside its library rail. The rail holds
 * the browsing interface - every note, searchable, one page at a time - while
 * the column stays the distraction-free editor it already was.
 *
 * The rail behaves like the shell's own rail: it can be put away (the choice
 * persists in this browser, mirrored by the edge opener that brings it back),
 * and it leaves the screen while the person is writing. Writing is the one
 * state where the rail must not compete: it fades to nothing for a beat after
 * the last keystroke, keeps its width so the prose never reflows under the
 * caret, and returns on its own. Searching the rail is not writing the note,
 * so it never triggers this.
 *
 * Cmd/Ctrl+K opens the note finder here: the listener runs in the capture
 * phase so it answers before the global command layer, which keeps Cmd+K
 * everywhere else. The sidebar's search button opens the command layer by its
 * own event, so it is not taken here.
 *
 * `replaceUrl` names the note shown when the URL did not (bare /polymath/notes):
 * the URL catches up without a navigation, so the page renders once.
 */

const LIBRARY_OPEN_KEY = "polymath.notes.library";
/** How long the rail stays away after the last keystroke. */
const TYPING_IDLE_MS = 1000;
const WRITING_TARGET = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const EDITING_KEYS = new Set(["Backspace", "Delete", "Enter"]);

type LibraryControls = { open: boolean; toggle: () => void; openOnMobile: () => void };

const OpenSwitcher = createContext<() => void>(() => {});
const Library = createContext<LibraryControls | null>(null);

/* A tiny external store over localStorage, so the collapse choice applies at
   once and another tab's change arrives through "storage". */
const listeners = new Set<() => void>();

function readLibraryOpen(): boolean {
  try {
    return window.localStorage.getItem(LIBRARY_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function subscribeToLibrary(listener: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== LIBRARY_OPEN_KEY && event.key !== null) return;
    listener();
  }
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writeLibraryOpen(open: boolean) {
  try {
    window.localStorage.setItem(LIBRARY_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Blocked storage: there is nowhere to keep the choice, so it holds for this page.
  }
  for (const listener of listeners) listener();
}

/** A keystroke that edits the open note - not a shortcut, not the rail's search. */
function isWritingInNote(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-notes-library]")) return false;
  const field = target.closest(WRITING_TARGET);
  return field !== null && field.closest("[data-note-container]") !== null;
}

function writesText(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key.length === 1 || EDITING_KEYS.has(event.key);
}

export function NotebookWorkspace({
  children,
  replaceUrl,
  library,
}: {
  children: ReactNode;
  replaceUrl?: string;
  /** The library rail's content, server-rendered with the note. */
  library?: ReactNode;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const open = useSyncExternalStore(subscribeToLibrary, readLibraryOpen, () => true);
  const idleTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (replaceUrl) window.history.replaceState(null, "", replaceUrl);
  }, [replaceUrl]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!writesText(event) || !isWritingInNote(event.target)) return;
      setWriting(true);
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => setWriting(false), TYPING_IDLE_MS);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(idleTimer.current);
    };
  }, []);

  function toggleLibrary() {
    // A deliberate click outranks the typing hush: the rail must not vanish again
    // while the pointer is still on the control that just revealed it.
    window.clearTimeout(idleTimer.current);
    setWriting(false);
    writeLibraryOpen(!open);
  }

  const controls: LibraryControls | null = library
    ? { open, toggle: toggleLibrary, openOnMobile: () => setMobileOpen(true) }
    : null;
  const away = !open || writing;

  return (
    <OpenSwitcher.Provider value={() => setSwitcherOpen(true)}>
      <Library.Provider value={controls}>
        <div className={noteLayout.row}>
          {library ? (
            <aside
              id="notes-library"
              aria-label="Notes"
              data-notes-library
              data-state={!open ? "collapsed" : writing ? "writing" : "open"}
              inert={away}
              className={cn(
                "sticky top-0 hidden max-h-[100dvh] shrink-0 self-start overflow-hidden lg:block",
                "transition-[width,opacity,transform] duration-200 ease-out motion-reduce:transition-none",
                // Collapsed: the note column takes the room. Writing: the room
                // stays reserved so the prose does not reflow under the caret.
                open ? "w-64" : "pointer-events-none -translate-x-2 opacity-0",
                open && writing && "pointer-events-none opacity-0",
              )}
            >
              <div className="max-h-[100dvh] w-64 overflow-y-auto">{library}</div>
            </aside>
          ) : null}
          <div className={noteLayout.cell}>{children}</div>
          <NoteSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
        </div>
        {library ? (
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent side="left" className="w-72 overflow-y-auto pt-12">
              <SheetTitle className="sr-only">Notes</SheetTitle>
              <SheetDescription className="sr-only">Search and open a note.</SheetDescription>
              <div
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("a")) setMobileOpen(false);
                }}
              >
                {library}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
        {/* The way back when the rail is put away: the same top-left opener the
            shell's rail uses. Hidden below lg, where the header toggle opens the sheet. */}
        {library && !open ? (
          <button
            type="button"
            onClick={toggleLibrary}
            aria-label="Show the note list"
            aria-controls="notes-library"
            aria-expanded={false}
            className={cn(
              "fixed top-2 left-2 z-30 hidden size-8 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground lg:flex",
              "focus-visible:ring-3 focus-visible:ring-ring",
            )}
          >
            <PanelLeftOpen aria-hidden className="size-4" />
          </button>
        ) : null}
      </Library.Provider>
    </OpenSwitcher.Provider>
  );
}

/** Puts the library rail away, or opens it on a narrow screen. Renders nothing without a rail. */
export function LibraryToggle() {
  const library = useContext(Library);
  if (!library) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="hidden lg:inline-flex"
        aria-controls="notes-library"
        aria-expanded={library.open}
        aria-label={library.open ? "Hide the note list" : "Show the note list"}
        onClick={library.toggle}
      >
        {library.open ? (
          <PanelLeftClose aria-hidden className="text-muted-foreground" />
        ) : (
          <PanelLeftOpen aria-hidden className="text-muted-foreground" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        aria-label="Open the note list"
        onClick={library.openOnMobile}
      >
        <PanelLeftOpen aria-hidden className="text-muted-foreground" />
      </Button>
    </>
  );
}

/** Opens the note finder: the visible path to it on touch screens, and wherever the shortcut is not known. */
export function FindNoteButton({ icon = false }: { icon?: boolean }) {
  const open = useContext(OpenSwitcher);
  return icon ? (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Find a note" onClick={open}>
      <Search aria-hidden className="text-muted-foreground" />
    </Button>
  ) : (
    <Button type="button" variant="outline" onClick={open}>
      Find a note
    </Button>
  );
}
