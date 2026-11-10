"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import { generateNotebookQuizAction } from "./learning-actions";
import { generateNotebookFlashcardsAction } from "./flashcard-actions";
import { startNotebookExplainItAction } from "./explain-actions";

type LearningSource = { documentId: string; title: string };

export function LearningStudio({ projectId, sources }: { projectId: string; sources: LearningSource[] }) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>(sources[0] ? [sources[0].documentId] : []);
  const [questionCount, setQuestionCount] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [cardCount, setCardCount] = useState(10);
  const [flashcardError, setFlashcardError] = useState<string | null>(null);
  const [flashcardRequestKey, setFlashcardRequestKey] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainRequestKey, setExplainRequestKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleSource(documentId: string) {
    setRequestKey(null);
    setFlashcardRequestKey(null);
    setExplainRequestKey(null);
    setSelectedIds((current) =>
      current.includes(documentId) ? current.filter((id) => id !== documentId) : [...current, documentId],
    );
  }

  function createQuiz() {
    setError(null);
    startTransition(async () => {
      const idempotencyKey = requestKey ?? crypto.randomUUID();
      setRequestKey(idempotencyKey);
      const result = await generateNotebookQuizAction({
        projectId,
        documentIds: selectedIds,
        questionCount,
        idempotencyKey,
      });
      if (!result.ok) {
        setError(result.error);
        setRequestKey(null);
        return;
      }
      router.push(`/projects/${projectId}/notebook?quiz=${result.quizId}`);
    });
  }

  function startExplainIt() {
    setExplainError(null);
    startTransition(async () => {
      const idempotencyKey = explainRequestKey ?? crypto.randomUUID();
      setExplainRequestKey(idempotencyKey);
      const result = await startNotebookExplainItAction({ projectId, documentIds: selectedIds, idempotencyKey });
      if (!result.ok) {
        setExplainError(result.error);
        setExplainRequestKey(null);
        return;
      }
      router.push("/projects/" + projectId + "/notebook/explain?session=" + result.sessionId);
    });
  }

  function createFlashcards() {
    setFlashcardError(null);
    startTransition(async () => {
      const idempotencyKey = flashcardRequestKey ?? crypto.randomUUID();
      setFlashcardRequestKey(idempotencyKey);
      const result = await generateNotebookFlashcardsAction({
        projectId,
        documentIds: selectedIds,
        cardCount,
        idempotencyKey,
      });
      if (!result.ok) {
        setFlashcardError(result.error);
        setFlashcardRequestKey(null);
        return;
      }
      router.push("/projects/" + projectId + "/notebook/flashcards?deck=" + result.deckId);
    });
  }

  return (
    <section aria-labelledby="learning-title" className="panel rounded-xl p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="learning-title" className="text-body-dense font-medium">
          Learning
        </h2>
        <Link href="/learn" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          Up next
        </Link>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Build a quiz from selected notebook sources.</p>
      {sources.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">A source must finish reading before it can be studied.</p>
      ) : (
        <>
          <fieldset className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
            <legend className="sr-only">Quiz sources</legend>
            {sources.map((source) => (
              <label
                key={source.documentId}
                className="flex items-start gap-2 rounded px-1 py-1 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(source.documentId)}
                  onChange={() => toggleSource(source.documentId)}
                  className="mt-0.5"
                />
                <span className="min-w-0 break-words">{source.title}</span>
              </label>
            ))}
          </fieldset>
          <label className="mt-2 flex items-center justify-between gap-2 text-xs">
            <span>Questions</span>
            <select
              aria-label="Number of quiz questions"
              value={questionCount}
              onChange={(event) => {
                setRequestKey(null);
                setQuestionCount(Number(event.target.value));
              }}
              className="h-7 rounded-md border border-border bg-background px-2 text-body-dense"
            >
              {[5, 10, 25, 50].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <Button
            className="mt-2 w-full"
            size="sm"
            variant="outline"
            disabled={pending || selectedIds.length === 0 || selectedIds.length > 8}
            onClick={createQuiz}
          >
            {pending ? "Building quiz…" : "Create quiz"}
          </Button>
          {selectedIds.length > 8 ? (
            <p className="mt-1 text-xs text-muted-foreground">Select up to eight sources.</p>
          ) : null}
          {error ? <WorkStatus state={{ phase: "failed", label: error }} className="mt-2" /> : null}
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="text-body-dense font-medium">Flashcards</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Generate cards on request, then rate recall to schedule your personal review queue.
            </p>
            <label className="mt-2 flex items-center justify-between gap-2 text-xs">
              <span>Cards</span>
              <select
                aria-label="Number of flashcards"
                value={cardCount}
                onChange={(event) => {
                  setFlashcardRequestKey(null);
                  setCardCount(Number(event.target.value));
                }}
                className="h-7 rounded-md border border-border bg-background px-2 text-body-dense"
              >
                {[5, 10, 25, 50].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="outline"
              disabled={pending || selectedIds.length === 0 || selectedIds.length > 8}
              onClick={createFlashcards}
            >
              {pending ? "Making flashcards…" : "Generate flashcards"}
            </Button>
            {flashcardError ? <WorkStatus state={{ phase: "failed", label: flashcardError }} className="mt-2" /> : null}
          </div>
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="text-body-dense font-medium">Explain It</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Explain a concept in your own words. Follow-up questions adapt to your answer and cite the selected
              sources.
            </p>
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="outline"
              disabled={pending || selectedIds.length === 0 || selectedIds.length > 8}
              onClick={startExplainIt}
            >
              {pending ? "Starting…" : "Start Explain It"}
            </Button>
            {explainError ? <WorkStatus state={{ phase: "failed", label: explainError }} className="mt-2" /> : null}
          </div>
          <Link
            href={"/projects/" + projectId + "/notebook/graph"}
            className="mt-4 block rounded-md border border-border px-3 py-2 text-center text-sm hover:bg-muted"
          >
            Open idea graph
          </Link>
        </>
      )}
    </section>
  );
}
