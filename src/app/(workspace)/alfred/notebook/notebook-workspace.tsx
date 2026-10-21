"use client";

import { useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";

export function NotebookWorkspace({ list, children }: { list: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-[60vh] flex-1 items-start gap-6">
      {open && <aside aria-label="Notes list" className="sticky top-0 hidden max-h-[100dvh] w-64 shrink-0 overflow-y-auto lg:block">{list}</aside>}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="overflow-y-auto p-4 pt-12">
          <SheetTitle>Notes</SheetTitle>
          <SheetDescription className="sr-only">Search and select a note.</SheetDescription>
          <div onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setMobileOpen(false); }}>{list}</div>
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1">
        <div className="mb-1 hidden lg:block">
          <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-label={open ? "Hide the note list" : "Show the note list"} onClick={() => setOpen((current) => !current)}>
            {open ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
          </Button>
        </div>
        <Button type="button" variant="ghost" size="sm" className="mb-2 lg:hidden" aria-label="Show the note list" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><PanelLeftOpen aria-hidden />Notes</Button>
        {children}
      </div>
    </div>
  );
}
