import Link from "next/link";
import { ArrowRight, BookOpen, CalendarDays, Gavel, ListChecks, NotebookPen, Play, Search } from "lucide-react";
import type { SurfaceCard } from "@/domains/supervisor/cards";

/*
 * ASH-306: a surface rendered inside the conversation. The card is a window
 * onto the canonical surface: real rows, deep links, and one door out to the
 * full view. Empty stays empty with a designed line, never a fake row.
 */

const SURFACE_ICON = {
  tasks: ListChecks,
  notes: NotebookPen,
  note_search: Search,
  calendar: CalendarDays,
  runs: Play,
  decisions: Gavel,
  library: BookOpen,
} as const;

export function SurfaceCardView({ card }: { card: SurfaceCard }) {
  const Icon = SURFACE_ICON[card.surface] ?? Search;
  return (
    <section
      aria-label={card.title}
      className="w-full max-w-xl rounded-xl border border-border/60 bg-card/60"
    >
      <header className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <h3 className="text-[13px] font-medium">{card.title}</h3>
        <Link
          href={card.href}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Open
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>
      {card.items.length ? (
        <ul className="divide-y divide-border/40">
          {card.items.map((item, index) => (
            <li key={`${item.label}-${index}`} className="flex items-baseline gap-3 px-3.5 py-2">
              {item.href ? (
                <Link href={item.href} className="min-w-0 flex-1 truncate text-[13px] leading-6 underline-offset-4 hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[13px] leading-6">{item.label}</span>
              )}
              {item.meta ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">{item.meta}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-[13px] text-muted-foreground">{card.emptyText ?? "Nothing here yet."}</p>
      )}
    </section>
  );
}

/** Reads a persisted surface-card part off a message's jsonb parts column. */
export function surfaceCardFromParts(parts: unknown): SurfaceCard | null {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (
      part && typeof part === "object"
      && (part as { type?: unknown }).type === "supervisor-surface"
      && typeof (part as { card?: unknown }).card === "object"
    ) {
      return (part as { card: SurfaceCard }).card;
    }
  }
  return null;
}
