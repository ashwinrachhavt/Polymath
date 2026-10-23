import Link from "next/link";

/*
 * The Work view tabs are task views only - Today, List, Board, Calendar and
 * Saved tasks. Whole features (Scheduler, Meetings, Brain dump, Weekly
 * review, Stone collection, Projects) are not tabs: they live where they are
 * used (the Calendar and Today surfaces link theirs) and in the More index
 * and command layer.
 */
import type { WorkView } from "@/components/products/neuralflow/work-views";

const views: { id: WorkView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "list", label: "List" },
  { id: "board", label: "Board" },
  { id: "calendar", label: "Calendar" },
  { id: "saved", label: "Saved tasks" },
];

export function WorkViewLinks({ active }: { active: WorkView }) {
  return (
    <nav aria-label="Work views" className="-mx-1 flex flex-nowrap gap-1 overflow-x-auto px-1 md:flex-wrap md:overflow-visible">
      {views.map(({ id, label }) => (
        <Link
          key={id}
          href={`/neuralflow/work?view=${id}`}
          aria-current={active === id ? "page" : undefined}
          className={`inline-flex min-h-9 items-center rounded-md px-3 text-[13px] font-medium transition-colors active:translate-y-px ${active === id ? "bg-app-accent text-app-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
