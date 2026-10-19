"use client";

import { useState, type DragEvent, type ReactNode } from "react";
import { cn } from "cn";
import { GripVertical } from "lucide-react";

/*
 * One ordered list, two ways to move a row: pointer drag and the keyboard.
 * Every list in Polymath that has an order uses this, so ranking behaves the same
 * in a board lane, a task queue and a saved view, and so the keyboard
 * alternative required by WCAG 2.2 cannot be forgotten in one of them.
 *
 * The caller owns the data. This component reports an intent (this id, at this
 * index) and re-renders from whatever the store returns.
 */

type ReorderListProps<T> = {
  items: T[];
  getId: (item: T) => string;
  onReorder: (id: string, index: number) => void;
  label: string;
  renderItem: (item: T, handle: ReactNode) => ReactNode;
  className?: string;
  itemClassName?: string;
};

export function ReorderList<T>({ items, getId, onReorder, label, renderItem, className, itemClassName }: ReorderListProps<T>) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);

  function end() { setDragging(null); setOver(null); }
  function drop(index: number) { if (dragging) onReorder(dragging, index); end(); }

  function handleKey(event: React.KeyboardEvent, id: string, index: number) {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    event.preventDefault();
    onReorder(id, target);
  }

  return (
    <ul className={className} aria-label={label}>
      {items.map((item, index) => {
        const id = getId(item);
        const handle = (
          <button
            type="button"
            draggable
            aria-label={`Reorder ${label.toLowerCase()}. Item ${index + 1} of ${items.length}. Use arrow up and arrow down.`}
            className={cn("mt-0.5 flex size-6 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing", dragging === id && "bg-muted text-foreground")}
            onDragStart={(event: DragEvent) => { setDragging(id); event.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={end}
            onKeyDown={(event) => handleKey(event, id, index)}
          >
            <GripVertical aria-hidden className="size-4" />
          </button>
        );
        return (
          <li
            key={id}
            className={cn(itemClassName, over === index && dragging && dragging !== id && "shadow-[inset_0_2px_var(--ring)]")}
            onDragOver={(event) => { if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(index); }}
            onDrop={(event) => { event.preventDefault(); drop(index); }}
          >
            {renderItem(item, handle)}
          </li>
        );
      })}
    </ul>
  );
}
