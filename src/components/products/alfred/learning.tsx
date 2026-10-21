"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Screen, Panel, Status, Empty, Unavailable } from "@/components/workspace/ui";
import { useAlfredPreview } from "./preview-state";

/*
 * Learning: recall practice over the owner's own knowledge. Flashcards and
 * quizzes are generated from canonical zettels, and that generation is not
 * connected, so there is no deck to show. The screen says so and names the
 * action that fills it; it never ships a fabricated sample deck.
 * Recorded attempts are real local history and stay.
 */
export default function Learning() {
  const preview = useAlfredPreview();
  return <Screen title="Learning" description="Recall practice over your own zettels: flashcards and quizzes generated from cards you wrote, with attempts kept in this browser."><div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><Panel title="Flashcards and quizzes"><Empty title="No practice deck yet" description="A deck is generated from your atomic zettels, so practice always tests what you actually wrote. Write zettels first; generation itself is not connected yet." action={<Button asChild variant="outline"><Link href="/apps/alfred/zettels">Write a zettel</Link></Button>} /><div className="mt-4"><Unavailable feature="Deck generation">No flashcard or quiz content has been generated, and none is fabricated. There is no spaced-repetition schedule or retention score here.</Unavailable></div></Panel><Panel title="Browser-only attempts">{preview.state.attempts.length ? preview.state.attempts.slice(0, 30).map((attempt) => <div key={attempt.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3 text-[13px] last:border-0"><div><Status>{attempt.mode}</Status><p className="mt-1">{attempt.result}</p></div><span className="readout text-xs text-muted-foreground">{new Date(attempt.at).toLocaleString()}</span></div>) : <Empty title="No attempts yet" description="No attempts yet." />}</Panel></div></Screen>;
}
