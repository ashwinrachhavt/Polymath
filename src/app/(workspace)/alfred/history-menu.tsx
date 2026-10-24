"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { displayTitle } from "@/lib/display-text";

export type HistoryMenuRow = { id: string; objective: string; time: string; href?: string };
export type HistoryMenuGroup = { key: string; label: string; rows: HistoryMenuRow[] };

/*
 * The history disclosure above the composer. Local state rather than Radix
 * Popover: the rows are plain links, so there is no list to rove with arrow
 * keys and no selection to trap. Escape, outside click, and navigation are
 * three short effects and one click handler; a portal would buy nothing.
 *
 * Rows are grouped and stamped on the server, so the panel never disagrees
 * with itself across hydration or a long-lived tab.
 */
export function HistoryMenu({ groups }: { groups: HistoryMenuGroup[] }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pathname = usePathname();
  // Navigation from anywhere else (the rail, a command) leaves the panel
  // floating over the new screen. Adjusting during render is the React-blessed
  // form of "reset state when an input changes"; an effect would paint the
  // stale panel for one frame first.
  const [atPath, setAtPath] = useState(pathname);
  if (atPath !== pathname) {
    setAtPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="icon"
        aria-label="New chat"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus aria-hidden />
      </Button>

      {open ? (
        <div
          id={panelId}
          className="panel bg-popover text-popover-foreground shadow-raised absolute top-full left-0 z-50 mt-1 w-[320px] rounded-[9px] p-1"
        >
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-[12px]">
              No conversations yet.
            </p>
          ) : (
            <nav aria-label="Chat history">
              {groups.map((group) => (
                <div key={group.key}>
                  <p className="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-medium">
                    {group.label}
                  </p>
                  <ul className="flex flex-col gap-[2px]">
                    {group.rows.map((row) => (
                      <li key={row.id}>
                        <Link
                          href={row.href ?? `/alfred/${row.id}`}
                          onClick={() => setOpen(false)}
                          className="hover:bg-muted focus-visible:ring-ring flex h-8 items-center gap-3 rounded-md px-2 text-[13px] outline-none focus-visible:ring-3"
                        >
                          <span className="min-w-0 flex-1 truncate">{displayTitle(row.objective)}</span>
                          <span className="text-muted-foreground shrink-0 text-[12px]">
                            {row.time}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          )}
        </div>
      ) : null}
    </div>
  );
}
