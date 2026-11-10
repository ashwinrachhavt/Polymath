"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { NoteSwitcher } from "@/components/shell/note-switcher";

/*
 * The notes page is one note column. Cmd/Ctrl+K opens the note finder here,
 * and only on the notes routes: the listener runs in the capture phase so it
 * answers before the global command layer, which keeps Cmd+K everywhere else.
 */
export function NotebookWorkspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onNotes = pathname === "/polymath/notes" || pathname.startsWith("/polymath/notes/");
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    if (!onNotes) return;
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [onNotes]);

  return (
    <div className="flex flex-1 items-start gap-6">
      <div className="min-w-0 flex-1">{children}</div>
      <NoteSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
    </div>
  );
}
