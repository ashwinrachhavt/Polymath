"use client";

import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/*
 * One place that states every keyboard route through the product. Anything
 * added elsewhere has to be listed here, which is what keeps the list honest
 * and what makes "keyboard alternatives exist" checkable rather than assumed.
 */
const groups: { name: string; items: { keys: string; action: string }[] }[] = [
  { name: "Anywhere", items: [
    { keys: "Ctrl/⌘ K", action: "Open search and commands" },
    { keys: "Ctrl/⌘ Shift C", action: "Capture without leaving the screen" },
    { keys: "Shift ?", action: "Open this list" },
    { keys: "/", action: "Insert a block in the note editor" },
  ] },
  { name: "Lists and boards", items: [
    { keys: "Tab", action: "Move through rows and controls" },
    { keys: "Space", action: "Complete or reopen the focused task" },
    { keys: "Alt Arrow Left / Right", action: "Move a board task between lanes" },
    { keys: "Arrow Up / Down on a handle", action: "Rank a task up or down" },
  ] },
  { name: "Task inspector", items: [
    { keys: "Escape", action: "Close the inspector" },
    { keys: "Enter", action: "Submit the open form" },
  ] },
];

export function ShortcutsDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "?") { event.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>{trigger || <Button variant="ghost" size="sm"><Keyboard aria-hidden className="size-4" /><span className="sr-only">Keyboard shortcuts</span></Button>}</DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogDescription>Every action in Polymath is reachable without a pointer, including ranking and lane changes.</DialogDescription>
      {groups.map((group) => <section key={group.name} className="mt-5">
        <h3 className="text-[13px] font-medium">{group.name}</h3>
        <dl className="mt-2 divide-y divide-border">
          {group.items.map((item) => <div key={item.keys} className="flex items-baseline justify-between gap-4 py-2 text-[13px]"><dt>{item.action}</dt><dd className="readout shrink-0 text-xs text-muted-foreground">{item.keys}</dd></div>)}
        </dl>
      </section>)}
    </DialogContent>
  </Dialog>;
}
