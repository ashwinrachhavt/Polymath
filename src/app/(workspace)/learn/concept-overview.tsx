import Link from "next/link";
import type { ConceptOverview, ConceptOverviewRow } from "@/domains/learning/concept-overview";
import { CONCEPT_STATUS_COPY, coverageTotal } from "@/domains/learning/concept-status";

/*
 * "What do I know and how well": every concept the person has actually
 * studied, what covers it, how many answers were right with no help, and when
 * it was last seen. The status is the stored evidence, worded plainly; nothing
 * here reads a model's opinion of itself.
 *
 * Older items made before concepts had links are counted in one line, apart
 * from any concept - they are not failures, they simply cannot speak to one
 * thing yet.
 */

const KIND_LABEL = { quiz: "Quiz", deck: "Flashcards", explain: "Explain It" } as const;

export function ConceptOverviewSection({ overview }: { overview: ConceptOverview }) {
  const { concepts, unlinked } = overview;
  const olderCount = unlinked.questions + unlinked.cards + unlinked.explanations;

  return (
    <section aria-labelledby="concepts-title" className="panel mt-4 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="concepts-title" className="font-medium">
            What you know
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each idea your quizzes, cards and explanations cover, and whether you have proven it with no help.
          </p>
        </div>
      </div>
      {concepts.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing to show yet. Make a quiz, flashcards or an Explain It session and the ideas they cover appear here.
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {concepts.map((row) => (
            <li key={row.conceptId}>
              <ConceptCard row={row} />
            </li>
          ))}
        </ul>
      )}
      {olderCount > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {olderCount === 1 ? "One older item is" : `${olderCount} older items are`} not yet linked to a concept. They
          count neither for nor against any idea above.
        </p>
      ) : null}
    </section>
  );
}

function ConceptCard({ row }: { row: ConceptOverviewRow }) {
  const copy = CONCEPT_STATUS_COPY[row.status];
  const coverage = coverageTotal(row.coverage);
  return (
    <article className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 font-medium break-words">{row.term}</h3>
        <span
          data-concept-status={row.status}
          className={
            "shrink-0 rounded-full border px-2 py-0.5 text-xs " +
            (row.status === "proven"
              ? "border-border text-foreground"
              : row.status === "practised"
                ? "border-border text-muted-foreground"
                : "border-dashed border-border text-muted-foreground")
          }
        >
          {copy.label}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{copy.detail}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Covers </dt>
          <dd className="inline">
            {coverage === 0
              ? "no items yet"
              : [
                  row.coverage.questions > 0 ? `${row.coverage.questions} questions` : "",
                  row.coverage.cards > 0 ? `${row.coverage.cards} cards` : "",
                  row.coverage.explanations > 0 ? `${row.coverage.explanations} explanations` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
          </dd>
        </div>
        <div>
          <dt className="inline">Right with no help </dt>
          <dd className="inline">{row.unaidedCorrect}</dd>
        </div>
        <div className="col-span-2">
          <dt className="inline">Last seen </dt>
          <dd className="inline">{row.lastSeenAt ? relativeDay(row.lastSeenAt) : "never"}</dd>
        </div>
      </dl>
      {row.items.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {row.items.map((item) => (
            <li key={item.kind + item.href}>
              <Link href={item.href} className="underline underline-offset-4 hover:text-foreground">
                {KIND_LABEL[item.kind]}: {item.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** "today", "yesterday", "4 days ago": enough for "when was this last seen". */
function relativeDay(when: Date): string {
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
