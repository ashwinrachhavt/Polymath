"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Screen, Panel, Status, Empty } from "@/components/workspace/ui";
import type { LearningItemView } from "@/domains/learning/queries";
import type { LearningResult } from "@/domains/learning/sm2";
import { approveItemAction, approveItemsAction, createDeckAction, generateQuizAction, recordAttemptAction, retireItemAction } from "./actions";

/*
 * The learning surface (NotebookLM parity, S4).
 *
 * Read the structure the way NotebookLM shows it: decks on the left, the
 * proposed queue (what the model made and a human has not approved) above the
 * due queue. A generated question is never takeable until it is approved, which
 * is the repo's rule and also the sane one.
 *
 * Grading is a measured act: every answer writes an attempt and reschedules the
 * card. The four buttons are the SM-2 grades, in plain words.
 */

const GRADES: Array<{ result: LearningResult; label: string }> = [
  { result: "forgot", label: "Forgot" },
  { result: "struggled", label: "Struggled" },
  { result: "recalled", label: "Recalled" },
  { result: "explained", label: "Explained" },
  { result: "applied", label: "Applied" },
];

type DeckRow = {
  id: string;
  name: string;
  description: string | null;
  total: number;
  due: number;
  proposed: number;
};

export default function LearningSurface({
  initialDecks,
  dueByDeck,
  proposedByDeck,
  documents,
}: {
  initialDecks: DeckRow[];
  dueByDeck: Record<string, LearningItemView[]>;
  proposedByDeck: Record<string, LearningItemView[]>;
  documents: Array<{ id: string; title: string }>;
}) {
  const [decks, setDecks] = useState(initialDecks);
  const [deckId, setDeckId] = useState<string | null>(initialDecks[0]?.id ?? null);
  const [newDeckName, setNewDeckName] = useState("");
  const [documentId, setDocumentId] = useState(documents[0]?.id ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const due = dueByDeck[deckId ?? ""] ?? [];
  const proposed = proposedByDeck[deckId ?? ""] ?? [];
  const selected = useMemo(() => decks.find((d) => d.id === deckId) ?? null, [decks, deckId]);

  function run(fn: () => Promise<string>) {
    setMessage(null);
    startTransition(async () => {
      try {
        setMessage(await fn());
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "That did not work. Try again.");
      }
    });
  }

  function addDeck() {
    const name = newDeckName.trim();
    if (!name) return;
    run(async () => {
      const deck = await createDeckAction({ name });
      setDecks((current) => [...current, { id: deck.id, name, description: null, total: 0, due: 0, proposed: 0 }]);
      setDeckId(deck.id);
      setNewDeckName("");
      return `Deck "${name}" created.`;
    });
  }

  function generate() {
    if (!deckId || !documentId) return;
    run(async () => {
      const out = await generateQuizAction({ deckId, documentId, count: 10 });
      const suffix = out.budgetStopped ? " The free allowance ran out, so the batch stopped early." : "";
      return `${out.created} question(s) added from the source, ${out.verified} passed the quote check.${suffix}`;
    });
  }

  function approve(itemId: string) {
    run(async () => {
      await approveItemAction({ itemId });
      return "Approved. It is in the due queue now.";
    });
  }

  function approveAll() {
    if (proposed.length === 0) return;
    run(async () => {
      const out = await approveItemsAction({ itemIds: proposed.map((p) => p.id) });
      return `${out.approved} question(s) approved.`;
    });
  }

  function retire(itemId: string) {
    run(async () => {
      await retireItemAction({ itemId, reason: "Retired from the learning surface" });
      return "Retired. It will not be scheduled again.";
    });
  }

  function grade(item: LearningItemView, result: LearningResult) {
    run(async () => {
      const out = await recordAttemptAction({ itemId: item.id, result, idempotencyKey: crypto.randomUUID() });
      return `Next review in ${out.intervalDays} day(s).`;
    });
  }

  return (
    <Screen
      title="Learning"
      description="Approved questions come back on a schedule. Generation proposes; you decide what is worth knowing."
    >
      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Panel title="Decks">
            {decks.length === 0 ? (
              <Empty title="No decks yet" />
            ) : (
              <ul className="flex flex-col">
                {decks.map((deck) => (
                  <li key={deck.id}>
                    <button
                      type="button"
                      onClick={() => setDeckId(deck.id)}
                      className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted ${
                        deck.id === deckId ? "bg-muted font-medium" : ""
                      }`}
                    >
                      <span className="min-w-0 truncate">{deck.name}</span>
                      <span className="readout text-xs text-muted-foreground">{deck.due}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addDeck();
              }}
            >
              <Input
                aria-label="New deck name"
                className="h-8 text-[13px]"
                placeholder="New deck"
                value={newDeckName}
                onChange={(e) => setNewDeckName(e.target.value)}
              />
              <Button type="submit" size="sm" variant="outline" disabled={busy || !newDeckName.trim()}>
                <Plus aria-hidden />
              </Button>
            </form>
          </Panel>
        </div>

        <div className="flex flex-col gap-6">
          {message && (
            <p role="status" className="text-[13px] text-muted-foreground">
              {message}
            </p>
          )}

          {selected && (
            <Panel title={selected.name} description={selected.description ?? undefined}>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
                  <span className="font-medium">Source</span>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-2 text-[13px]"
                    value={documentId}
                    onChange={(e) => setDocumentId(e.target.value)}
                  >
                    {documents.length === 0 && <option value="">No documents yet</option>}
                    {documents.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.title}
                      </option>
                    ))}
                  </select>
                </label>
                <Button onClick={generate} disabled={busy || !documentId || !deckId}>
                  {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
                  Generate 10 questions
                </Button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                A question whose quote is not in the source is dropped. Generation stops if the free allowance runs out.
              </p>
            </Panel>
          )}

          {proposed.length > 0 && (
            <Panel
              title="Waiting for approval"
              description={`${proposed.length} generated question(s). Nothing is scheduled until you approve it.`}
              actions={
                <Button size="sm" variant="outline" onClick={approveAll} disabled={busy}>
                  <Check aria-hidden />
                  Approve all
                </Button>
              }
            >
              <ul className="divide-y divide-border">
                {proposed.map((item) => (
                  <li key={item.id} className="py-3">
                    <p className="text-[13px] font-medium">{item.prompt}</p>
                    {item.options && (
                      <ol className="mt-1.5 grid gap-1 sm:grid-cols-2">
                        {item.options.map((option, i) => (
                          <li
                            key={i}
                            className={`rounded-md px-2 py-1 text-[13px] ${i === item.answerIndex ? "bg-muted font-medium" : "text-muted-foreground"}`}
                          >
                            {option}
                          </li>
                        ))}
                      </ol>
                    )}
                    {item.sourceQuote && (
                      <p className="mt-2 border-l-2 border-border pl-2 text-xs leading-relaxed text-muted-foreground">
                        {item.sourceQuote}
                        {item.sourceTitle ? ` — ${item.sourceTitle}` : ""}
                      </p>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => approve(item.id)} disabled={busy}>
                        <Check aria-hidden />
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => retire(item.id)} disabled={busy}>
                        <X aria-hidden />
                        Retire
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Due now" description={`${due.length} question(s) ready to review.`}>
            {due.length === 0 ? (
              <Empty
                title="Nothing due"
              />
            ) : (
              <ul className="flex flex-col gap-4">
                {due.map((item) => (
                  <li key={item.id} className="panel rounded-xl p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-[13px] font-medium">{item.prompt}</p>
                      <Status>{item.reviewCount === 0 ? "New" : `${item.reviewCount} review(s)`}</Status>
                    </div>
                    {item.options && (
                      <ol className="mt-2 grid gap-1 sm:grid-cols-2">
                        {item.options.map((option, i) => (
                          <li key={i} className="rounded-md px-2 py-1 text-[13px] text-muted-foreground">
                            {option}
                          </li>
                        ))}
                      </ol>
                    )}
                    {item.explanation && (
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.explanation}</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {GRADES.map((gradeOption) => (
                        <Button
                          key={gradeOption.result}
                          size="sm"
                          variant="outline"
                          onClick={() => grade(item, gradeOption.result)}
                          disabled={busy}
                        >
                          <RotateCcw aria-hidden />
                          {gradeOption.label}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </Screen>
  );
}
