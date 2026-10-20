import Link from "next/link";
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

export function FeatureLinks() {
  return (
    <nav aria-label="More tools" className="-mx-1 flex flex-nowrap items-center gap-x-4 overflow-x-auto px-1 text-xs text-muted-foreground md:flex-wrap md:gap-y-2 md:overflow-visible">
      <Link className="py-1 hover:text-foreground hover:underline" href="/neuralflow/focus">Focus</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/projects">Projects</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/scheduler">Scheduler</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/brain-dump">Brain dump</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/meetings">Meetings</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/notes">Notes</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/reports">Weekly review</Link>
      <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/rewards">Stone collection</Link>
    </nav>
  );
}
