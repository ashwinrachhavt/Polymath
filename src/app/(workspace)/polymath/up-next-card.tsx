import { Suspense } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AuthContext } from "@/domains/identity/resolve";
import { deckReviewHref } from "@/domains/learning/review-href";
import { getUpNext, type UpNext } from "@/domains/learning/up-next";

/*
 * Every state of the card shares one box, so the skeleton, the card and the
 * failure line all take the same space and nothing below them moves. Three
 * lines (12, 13 and 11px at the inherited 1.5 leading) plus the padding and
 * hairline come to 80px: h-20.
 */
const PANEL = "panel flex min-h-20 w-full items-center justify-between gap-4 rounded-lg px-4 py-3";

/*
 * Up next streams on its own. The page around it never waits on the learning
 * reads, and when one of them fails the card says so while the rest of the
 * page works.
 */
export function UpNextSection({ auth }: { auth: AuthContext }) {
  return (
    <Suspense fallback={<Skeleton role="status" aria-label="Loading Up next" className="h-20 w-full rounded-lg" />}>
      <UpNextContent auth={auth} />
    </Suspense>
  );
}

export async function UpNextContent({ auth }: { auth: AuthContext }) {
  let upNext: UpNext;
  try {
    upNext = await getUpNext(auth);
  } catch (error) {
    unstable_rethrow(error);
    console.error("Up next failed to load", error);
    return (
      <section aria-label="Up next" className={PANEL}>
        <div className="min-w-0">
          <p className="text-muted-foreground text-label font-medium">Up next</p>
          <p className="text-body-dense">Your flashcards and quizzes did not load. Reload the page to try again.</p>
        </div>
      </section>
    );
  }
  return <UpNextCard upNext={upNext} />;
}

/*
 * Home's trigger: one place to pick learning back up and one button to do it.
 * Continue goes to the cards that are due, else two ideas that disagree, else
 * the quiz never sat, else Learn, where flashcards and quizzes are made from
 * any sources. A broken streak simply disappears; the card never counts what
 * was missed.
 */
export function UpNextCard({ upNext }: { upNext: UpNext }) {
  const { dueCards, firstDue, quizWaiting, streakDays, disagreement } = upNext;
  const next = firstDue
    ? {
        href: deckReviewHref(firstDue),
        label: "Review the flashcards that are due.",
      }
    : disagreement
      ? {
          href: `/polymath/ideas?tidy=${disagreement.findingId}#tidy-${disagreement.findingId}`,
          label: `Two ideas disagree: "${disagreement.firstTitle}" and "${disagreement.secondTitle}". Decide which holds.`,
        }
      : quizWaiting
        ? { href: quizWaiting.href, label: `Take the quiz on ${quizWaiting.title}.` }
        : { href: "/learn", label: "Make flashcards or a quiz from any sources." };
  const progress = [
    dueCards === 0 ? "No cards due" : `${dueCards} ${dueCards === 1 ? "card" : "cards"} due`,
    disagreement
      ? `${disagreement.open} ${disagreement.open === 1 ? "disagreement" : "disagreements"} to settle`
      : null,
    streakDays > 0 ? `${streakDays}-day streak` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-label="Up next" className={PANEL}>
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
