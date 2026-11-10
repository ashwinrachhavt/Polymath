import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { UpNext } from "@/domains/learning/up-next";

/*
 * Home's trigger: one place to pick learning back up and one button to do it.
 * Continue goes to the cards that are due, else the quiz never sat, else the
 * Notebooks where learning is made. A broken streak simply disappears; the
 * card never counts what was missed.
 */
export function UpNextCard({ upNext }: { upNext: UpNext }) {
  const { dueCards, firstDue, quizWaiting, streakDays } = upNext;
  const next = firstDue
    ? {
        href: `/projects/${firstDue.notebookId}/notebook/flashcards?deck=${firstDue.deckId}`,
        label: "Review the flashcards that are due.",
      }
    : quizWaiting
      ? { href: quizWaiting.href, label: `Take the quiz on ${quizWaiting.title}.` }
      : { href: "/projects", label: "Make flashcards or a quiz from a Notebook." };
  const progress = [
    dueCards === 0 ? "No cards due" : `${dueCards} ${dueCards === 1 ? "card" : "cards"} due`,
    streakDays > 0 ? `${streakDays}-day streak` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-label="Up next" className="panel flex w-full items-center justify-between gap-4 rounded-lg px-4 py-3">
      <div className="min-w-0">
        <p className="text-muted-foreground text-label font-medium">Up next</p>
        <p className="truncate text-body-dense">{next.label}</p>
        <p className="text-muted-foreground text-data tabular-nums">{progress}</p>
      </div>
      <Button asChild>
        <Link href={next.href}>Continue</Link>
      </Button>
    </section>
  );
}
