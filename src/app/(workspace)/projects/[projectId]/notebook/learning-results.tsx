"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ArtifactRating } from "@/domains/knowledge/artifact-feedback";
import type { QuizForSitting } from "@/domains/learning/queries";
import { QuizRunner } from "../../../learn/[documentId]/quiz-runner";
import { ExplainItSession } from "./explain-session";
import { FlashcardSession } from "./flashcard-session";

/*
 * Results: the latest quiz, deck and Explain It session made in this
 * notebook, each a card that opens where it sits. Opening reveals the same
 * session component the standalone pages use, so nothing navigates and the
 * Notebook never loses its place.
 */

type Kind = "quiz" | "deck" | "explain";
type DeckCards = React.ComponentProps<typeof FlashcardSession>["initialCards"];
type ExplainSession = React.ComponentProps<typeof ExplainItSession>["session"];

export type LearningResultsData = {
  quiz: {
    id: string;
    title: string;
    ago: string;
    questionCount: number;
    note: string | null;
    quiz: QuizForSitting;
    rating: ArtifactRating | null;
  } | null;
  deck: {
    id: string;
    title: string;
    ago: string;
    cardCount: number;
    note: string | null;
    dueCards: DeckCards;
    rating: ArtifactRating | null;
  } | null;
  explain: { id: string; title: string; ago: string; session: ExplainSession } | null;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function ResultCard({
  label,
  title,
  ago,
  facts,
  note,
  open,
  onToggle,
  children,
}: {
  label: string;
  title: string;
  ago: string;
  facts: string;
  note: string | null;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <article aria-label={`${label}: ${title}`} className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <h3 className="truncate text-body-dense font-medium">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span>{facts}</span> · {ago}
          </p>
          {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
        </div>
        <Button size="sm" variant="outline" aria-expanded={open} onClick={onToggle}>
          {open ? "Close" : "Open"}
        </Button>
      </div>
      {open ? <div className="mt-3 border-t border-border pt-3">{children}</div> : null}
    </article>
  );
}

export function LearningResults({
  projectId,
  results,
  initiallyOpen,
}: {
  projectId: string;
  results: LearningResultsData;
  initiallyOpen: Kind | null;
}) {
  const [open, setOpen] = useState<Kind | null>(initiallyOpen);
  const toggle = (kind: Kind) => setOpen((current) => (current === kind ? null : kind));
  const { quiz, deck, explain } = results;

  return (
    <section aria-label="Results" className="panel rounded-xl p-3">
      <h2 className="text-body-dense font-medium">Results</h2>
      {!quiz && !deck && !explain ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Nothing made yet. Learn this makes a quiz, flashcards or an Explain It session from your sources.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {quiz ? (
            <ResultCard
              label="Quiz"
              title={quiz.title}
              ago={quiz.ago}
              facts={plural(quiz.questionCount, "question", "questions")}
              note={quiz.note}
              open={open === "quiz"}
              onToggle={() => toggle("quiz")}
            >
              <QuizRunner key={quiz.quiz.id} quiz={quiz.quiz} rating={quiz.rating} />
            </ResultCard>
          ) : null}
          {deck ? (
            <ResultCard
              label="Flashcards"
              title={deck.title}
              ago={deck.ago}
              facts={plural(deck.cardCount, "card", "cards")}
              note={deck.note}
              open={open === "deck"}
              onToggle={() => toggle("deck")}
            >
              <FlashcardSession
                key={deck.id}
                projectId={projectId}
                deckId={deck.id}
                title={deck.title}
                initialCards={deck.dueCards}
                rating={deck.rating}
              />
            </ResultCard>
          ) : null}
          {explain ? (
            <ResultCard
              label="Explain It"
              title={explain.title}
              ago={explain.ago}
              facts={plural(explain.session.turns.length, "question", "questions")}
              note={null}
              open={open === "explain"}
              onToggle={() => toggle("explain")}
            >
              <ExplainItSession key={explain.id} projectId={projectId} session={explain.session} />
            </ResultCard>
          ) : null}
        </div>
      )}
    </section>
  );
}
