"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, History } from "lucide-react";
import type { HistoryGroup } from "./history";

export type { HistoryGroup };

/*
 * The history chip. One control, two places it appears: on the idle home, and
 * in the corner of a conversation, where the transcript is the page and the
 * history must stay one click away without taking any of its width.
 *
 * Local state rather than Radix Popover: the rows are plain links, so there is
 * no list to rove with arrow keys and no selection to trap. Escape, outside
 * click, and navigation are three short effects and one click handler; a
 * portal would buy nothing.
 *
 * Rows are grouped and stamped on the server (see ./history), so the panel
 * never disagrees with the list on the home about which day a row is in.
 */
export function HistoryMenu({
  groups,
  label = "History",
  className,
}: {
  groups: HistoryGroup[];
  label?: string;
  className?: string;
}) {
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
    <div ref={container} className={`relative ${className ?? ""}`}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] outline-none transition-colors focus-visible:ring-2"
      >
        <History aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown
          aria-hidden
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          id={panelId}
          className="panel bg-popover text-popover-foreground shadow-raised absolute top-full left-0 z-50 mt-1.5 max-h-[min(70dvh,520px)] w-[320px] overflow-y-auto rounded-[9px] p-1.5"
        >
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-[12px]">No conversations yet.</p>
          ) : (
            <nav aria-label="Chat history" className="flex flex-col gap-1">
              {groups.map((group) => (
                <div key={group.key}>
                  <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-[11px] font-medium">
                    {group.label}
                  </p>
                  <ul className="flex flex-col">
                    {group.rows.map((row) => (
                      <li key={row.id}>
                        <Link
                          href={row.href}
                          onClick={() => setOpen(false)}
                          className="hover:bg-muted focus-visible:ring-ring flex h-8 items-center gap-3 rounded-md px-2 text-[13px] outline-none focus-visible:ring-2"
                        >
                          <span className="min-w-0 flex-1 truncate">{row.title}</span>
                          <span className="text-muted-foreground shrink-0 text-[12px] tabular-nums">
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
