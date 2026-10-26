"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";

type NotebookListControls = { open: boolean; toggle: () => void; openOnMobile: () => void };

// The list toggle belongs to the note's top row, but the list's state lives
// here; the context is how the two meet without making the page pass callbacks.
const NotebookListContext = createContext<NotebookListControls | null>(null);

/** The slim list's toggle, for any surface that renders inside the workspace. */
export function NotebookListToggle() {
  const list = useContext(NotebookListContext);
  if (!list) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="hidden lg:inline-flex"
        aria-expanded={list.open}
        aria-label={list.open ? "Hide the note list" : "Show the note list"}
        onClick={list.toggle}
      >
        {list.open ? <PanelLeftClose aria-hidden className="text-muted-foreground" /> : <PanelLeftOpen aria-hidden className="text-muted-foreground" />}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open the note list" onClick={list.openOnMobile}>
        <PanelLeftOpen aria-hidden className="text-muted-foreground" />
      </Button>
    </>
  );
}

export function NotebookWorkspace({ list, children }: { list: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <NotebookListContext.Provider value={{ open, toggle: () => setOpen((current) => !current), openOnMobile: () => setMobileOpen(true) }}>
      <div className="flex min-h-[60vh] flex-1 items-start gap-6">
        {open && <aside aria-label="Notes list" className="sticky top-0 hidden max-h-[100dvh] w-64 shrink-0 overflow-y-auto lg:block">{list}</aside>}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="overflow-y-auto p-4 pt-12">
            <SheetTitle>Notes</SheetTitle>
            <SheetDescription className="sr-only">Search and select a note.</SheetDescription>
            <div onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setMobileOpen(false); }}>{list}</div>
          </SheetContent>
        </Sheet>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </NotebookListContext.Provider>
  );
}
