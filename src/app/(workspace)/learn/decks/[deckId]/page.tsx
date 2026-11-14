import { notFound, redirect } from "next/navigation";
import { io } from "next/cache";
import { Suspense } from "react";
import { z } from "zod";
import { FlashcardSession } from "@/app/(workspace)/projects/[projectId]/notebook/flashcard-session";
import { ratingOf } from "@/domains/feedback/ratings";
import { getFlashcardDeck } from "@/domains/learning/flashcards";
import { deckReviewHref } from "@/domains/learning/review-href";
import { getAuthContext } from "@/lib/auth";
import { BackToLearn } from "../../back-to-learn";

export const metadata = { title: "Flashcards · Polymath" };

/*
 * Review for a deck made from picked sources on Learn or in the inbox. A deck
 * made inside a Notebook is reviewed there, so this page sends it on.
 */
export default function LearnDeckPage({ params }: { params: Promise<{ deckId: string }> }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Opening the flashcards…
        </p>
      }
    >
      <DeckReview params={params} />
    </Suspense>
  );
}

async function DeckReview({ params }: { params: Promise<{ deckId: string }> }) {
  await io();
  const { deckId } = await params;
  if (!z.uuid().safeParse(deckId).success) notFound();
  const auth = await getAuthContext();
  // Reopening a stack with nothing due studies the whole stack, ahead of schedule.
  const due = await getFlashcardDeck(auth, deckId, true);
  const deck = due && due.cards.length === 0 ? await getFlashcardDeck(auth, deckId) : due;
  if (!deck) notFound();
  if (deck.notebookId) redirect(deckReviewHref({ deckId: deck.id, notebookId: deck.notebookId }));
  const rating = await ratingOf(auth, { surface: "flashcards", id: deck.id });
  // The deck's title already names a single source; several are listed so "X + 2 more" is not a riddle.
  const sources = deck.sourceManifest.length > 1 ? deck.sourceManifest.map((source) => source.title).join(", ") : null;
  return (
    <div className="page-content">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <BackToLearn />
          <h1 className="min-w-0 text-xl font-medium">Flashcards</h1>
        </div>
        {sources ? <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">From {sources}</p> : null}
      </div>
      <FlashcardSession
        projectId={null}
        deckId={deck.id}
        title={deck.title}
        initialCards={deck.cards}
        rating={rating}
      />
    </div>
  );
}
