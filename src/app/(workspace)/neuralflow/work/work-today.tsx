import Link from "next/link";

/*
 * Work's two destinations and three presentations.
 *
 * Today and List are the destinations: today is the owner's commitment, List
 * is every task. Board and Calendar are not destinations - they render the
 * same canonical rows three ways, so they live as a presentation switch on the
 * same row rather than as tabs beside Today. Saved views were the Calendar's
 * bookmark store and are gone from this row.
 */
export type WorkDestination = "today" | "list";

const destinations: { id: WorkDestination; label: string; href: string }[] = [
  { id: "today", label: "Today", href: "/neuralflow/work?view=today" },
  { id: "list", label: "List", href: "/neuralflow/work?view=saved" },
];

const presentations: { id: "saved" | "board" | "calendar"; label: string }[] = [
  { id: "saved", label: "List" },
  { id: "board", label: "Board" },
  { id: "calendar", label: "Calendar" },
];

export function WorkViewLinks({ active, presentation }: { active: WorkDestination; presentation?: "saved" | "board" | "calendar" }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-border">
      <nav aria-label="Work views" className="flex gap-5">
        {destinations.map(({ id, label, href }) => {
          const current = active === id;
          return (
            <Link
              key={id}
              href={href}
              aria-current={current ? "page" : undefined}
              className={`-mb-px border-b-2 pb-2 text-[13px] transition-colors ${
                current
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <nav aria-label="Presentation" className="mb-1.5 flex gap-3 text-[12px]">
        {presentations.map(({ id, label }) => (
          <Link
            key={id}
            href={`/neuralflow/work?view=${id}`}
            aria-current={presentation === id ? "true" : undefined}
            className={presentation === id ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
          >
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
