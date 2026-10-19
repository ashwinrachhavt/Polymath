import Link from "next/link";
import type { getTaskProvenance } from "@/domains/knowledge/queries";

type Provenance = Awaited<ReturnType<typeof getTaskProvenance>>;

const stamp = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

/*
 * ASH-129: "why this task exists". When an accepted document obligation made
 * this task, show the chain back: the obligation, the document it came from,
 * the passage it rests on, and the decisions the audit kept. A task that did
 * not come from a document renders nothing, so ordinary tasks stay quiet.
 */
export function TaskEvidence({ items }: { items: Provenance }) {
  if (items.length === 0) return null;
  return (
    <div className="border-border mt-4 border-t pt-4">
      <p className="mb-2 text-[13px] font-medium">Why this task exists</p>
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.obligationId} className="flex flex-col gap-1.5">
            <p className="text-[13px]">{item.note ?? item.kind}</p>
            <p className="text-muted-foreground text-xs">
              From{" "}
              {item.sourceUrl ? (
                <span>{item.documentTitle}</span>
              ) : (
                <Link href={`/alfred/files`} className="underline-offset-4 hover:underline">
                  {item.documentTitle}
                </Link>
              )}
              {item.dueFromDocument ? ` · due as written: ${String(item.dueFromDocument)}` : ""}
            </p>
            {item.passage ? (
              <blockquote className="border-border text-muted-foreground border-l-2 pl-2 text-xs">
                {item.fieldName ? `${item.fieldName.replace(/_/g, " ")}: ` : ""}
                {item.passage}
              </blockquote>
            ) : (
              <p className="text-muted-foreground text-xs">No passage was recorded for this obligation.</p>
            )}
            {item.history.length > 0 ? (
              <ol className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                {item.history.map((event, i) => (
                  <li key={`${event.action}-${i}`}>
                    <span className="readout">{stamp.format(event.createdAt)}</span> · {event.summary}
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
