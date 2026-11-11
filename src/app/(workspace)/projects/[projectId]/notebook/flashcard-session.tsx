"use client";

import { useState, useTransition } from "react";
import { rateDeckFlashcardAction } from "@/app/(workspace)/learn/actions";
import { rateNotebookFlashcardAction } from "./flashcard-actions";
import { ArtifactFeedback } from "@/app/(workspace)/artifacts/[artifactId]/artifact-feedback";
import type { ArtifactRating } from "@/domains/knowledge/artifact-feedback";

type Card = {
  id: string;
  prompt: string;
  answer: string;
  evidence: { quote: string; source: { documentId: string; extractionId: string; title: string } };
  dueAt: Date;
};

const RATINGS = [
  { value: "again", label: "Again" },
  { value: "hard", label: "Hard" },
  { value: "good", label: "Good" },
  { value: "easy", label: "Easy" },
] as const;

export function FlashcardSession({
  projectId,
  deckId,
  title,
  initialCards,
  rating,
}: {
  /** The Notebook the deck belongs to; null for a deck made on Learn or in the inbox. */
  projectId: string | null;
  deckId: string;
  title: string;
  initialCards: Card[];
  rating: ArtifactRating | null;
}) {
  const [cards] = useState(initialCards);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const card = cards[index];

  function rate(rating: (typeof RATINGS)[number]["value"]) {
    if (!card) return;
    setError(null);
    startTransition(async () => {
      const input = { deckId, flashcardId: card.id, rating };
      const result = projectId
        ? await rateNotebookFlashcardAction({ ...input, projectId })
        : await rateDeckFlashcardAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const next = index + 1;
      setIndex(next);
      setRevealed(false);
    });
  }

  return (
    <section aria-label="Flashcard review" className="mx-auto w-full max-w-2xl">
      <p className="mb-3 text-xs text-muted-foreground">{title}</p>
      {card ? (
        <article className="rounded-xl border border-border p-6">
          <p className="mb-2 text-xs text-muted-foreground">
            Card {index + 1} of {cards.length}
          </p>
          <h2 className="text-lg font-medium leading-relaxed">{card.prompt}</h2>
          {revealed ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="leading-relaxed">{card.answer}</p>
              <blockquote className="mt-4 border-l-2 border-border pl-3 text-sm text-muted-foreground">
                {card.evidence.quote}
                <footer className="mt-1 text-xs">{card.evidence.source.title}</footer>
              </blockquote>
              <p className="mt-5 text-xs text-muted-foreground">How well did you recall it?</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {RATINGS.map((rating) => (
                  <button
                    key={rating.value}
                    type="button"
                    disabled={pending}
                    onClick={() => rate(rating.value)}
                    className="rounded-md border border-border px-2 py-2 text-body-dense hover:bg-muted disabled:opacity-50"
                  >
                    {pending ? "Saving…" : rating.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="mt-5 rounded-md border border-border px-3 py-2 text-body-dense hover:bg-muted"
              onClick={() => setRevealed(true)}
            >
              Show answer
            </button>
          )}
        </article>
      ) : (
        <div className="rounded-xl border border-border p-6">
          <h2 className="font-medium">Review complete</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            These cards are scheduled for review. More will appear here when they are due.
          </p>
          <ArtifactFeedback target={{ kind: "flashcard_deck", id: deckId }} rating={rating} />
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
