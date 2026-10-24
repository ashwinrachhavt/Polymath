"use client";

import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "cn";

/*
 * The composer's plus button: one control, bottom-left, that opens the small
 * menu of things a message can carry. ChatGPT-shaped: a round hover target
 * the same size as the send button, quiet until hovered.
 *
 * What the menu holds is decided by the caller through `items`, because the
 * home composer and the in-conversation composer can carry different things:
 * the home pins skills, the conversation surface attaches files. A caller
 * with nothing to offer passes no items and the button does not render — a
 * plus that opens an empty menu is chrome lying about capability.
 */

export type ComposerPlusItem = {
  label: string;
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
};

export function ComposerPlus({
  items,
  label = "Add to message",
  disabled = false,
}: {
  items: ComposerPlusItem[];
  /** Accessible name; the home composer and reply composer frame it differently. */
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        <Plus aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="bg-popover text-popover-foreground border-border z-50 min-w-56 rounded-xl border p-1 shadow-md"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none"
            >
              <span className="text-muted-foreground shrink-0 [&_svg]:size-4">{item.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.hint ? (
                  <span className="text-muted-foreground block truncate text-[11px]">{item.hint}</span>
                ) : null}
              </span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
