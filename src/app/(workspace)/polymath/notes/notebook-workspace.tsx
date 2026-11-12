"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { NoteSwitcher } from "@/components/shell/note-switcher";

/*
 * The client frame around the notes page.
 *
 * Cmd/Ctrl+K opens the note finder here: the listener runs in the capture
 * phase so it answers before the global command layer, which keeps Cmd+K
 * everywhere else. The sidebar's search button opens the command layer by its
 * own event, so it is not taken here.
 *
 * `replaceUrl` names the note shown when the URL did not (bare /polymath/notes):
 * the URL catches up without a navigation, so the page renders once.
 */

const OpenSwitcher = createContext<() => void>(() => {});

export function NotebookWorkspace({ children, replaceUrl }: { children: ReactNode; replaceUrl?: string }) {
  const [switcherOpen, setSwitcherOpen] = useState(false);

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

  return (
    <OpenSwitcher.Provider value={() => setSwitcherOpen(true)}>
      {children}
      <NoteSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
    </OpenSwitcher.Provider>
  );
}

/** Opens the note finder: the visible path to it on touch screens, and wherever the shortcut is not known. */
export function FindNoteButton() {
  const open = useContext(OpenSwitcher);
  return (
    <Button type="button" variant="outline" onClick={open}>
      Find a note
    </Button>
  );
}
