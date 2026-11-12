"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WorkStatus } from "@/components/work-status";
import { MAX_ITEM_COUNT, MIN_ITEM_COUNT } from "@/domains/learning/item-count";
import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import { trackGenerationJob } from "@/components/jobs/generation-jobs";
import type { GenerationJobView } from "@/domains/jobs/state";
import { LEARNING_JOB_KIND_PREFIX, learningJobSubject } from "@/domains/learning/job-names";
import { makeNotebookLearningAction } from "./learning-actions";
import { startNotebookExplainItAction } from "./explain-actions";

/*
 * The Notebook's one learning action. Learn this opens a sheet with three
 * choices; the default sends every ready source and no count, so the server
 * sizes the set from the sources. Adjust holds the source checkboxes and an
 * exact count. A quiz or a deck is made in the background: the sheet closes
 * as soon as the request is accepted, a row here says how the work is going,
 * and the result appears in Results on this page when it is ready. Explain It
 * starts with one short call, so it is still awaited.
 */

type LearningSource = { documentId: string; title: string };
type Kind = "quiz" | "flashcards" | "explain";

/** The most sources one request reads; the actions enforce the same cap. */
const MAX_SOURCES = 8;

const CHOICES: Array<{ kind: Kind; label: string; blurb: string; noun: string | null }> = [
  { kind: "quiz", label: "Quiz", blurb: "Questions with instant feedback.", noun: "questions" },
  { kind: "flashcards", label: "Flashcards", blurb: "Cards you rate to schedule reviews.", noun: "flashcards" },
  { kind: "explain", label: "Explain It", blurb: "Teach it back in your own words.", noun: null },
];

function sourcesLine(chosen: number, ready: number): string {
  if (chosen === ready) return ready === 1 ? "Uses your 1 ready source." : `Uses all ${ready} ready sources.`;
  return `Uses ${chosen} of ${ready} ready sources.`;
}

export function LearningStudio({
  projectId,
  sources,
  initialJobs,
}: {
  projectId: string;
  sources: LearningSource[];
  /** This Notebook's unfinished quiz and deck jobs when the page rendered. */
  initialJobs: GenerationJobView[];
}) {
  const surface = useSurfaceJobs(initialJobs, {
    kindPrefix: LEARNING_JOB_KIND_PREFIX,
    subject: learningJobSubject.notebook(projectId),
  });
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("quiz");
  // Only the user's changes are held; everything else follows the ready sources,
  // so a source that finishes later is included and a removed one drops out.
  const [deselected, setDeselected] = useState<string[]>([]);
  const [added, setAdded] = useState<string[]>([]);
  const defaultIds = sources.slice(0, MAX_SOURCES).map((source) => source.documentId);
  const selectedIds = sources
    .map((source) => source.documentId)
    .filter((id) => (defaultIds.includes(id) ? !deselected.includes(id) : added.includes(id)));
  const [countText, setCountText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A retry of the same request replays its key; any change makes a new one.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const choice = CHOICES.find((item) => item.kind === kind) ?? CHOICES[0];
  const trimmed = countText.trim();
  const count = trimmed === "" ? undefined : Number(trimmed);
  const countValid =
    count === undefined || (Number.isInteger(count) && count >= MIN_ITEM_COUNT && count <= MAX_ITEM_COUNT);
  const problem =
    sources.length === 0
      ? "A source must finish reading before it can be studied."
      : selectedIds.length === 0
        ? "Choose at least one source."
        : selectedIds.length > MAX_SOURCES
          ? `Choose up to ${MAX_SOURCES} sources.`
          : choice.noun && !countValid
            ? `Choose a number from ${MIN_ITEM_COUNT} to ${MAX_ITEM_COUNT}, or leave it blank.`
            : null;

  function toggleSource(documentId: string) {
    const on = selectedIds.includes(documentId);
    if (defaultIds.includes(documentId)) {
      setDeselected((current) => (on ? [...current, documentId] : current.filter((id) => id !== documentId)));
    } else {
      setAdded((current) => (on ? current.filter((id) => id !== documentId) : [...current, documentId]));
    }
  }

  function create() {
    if (problem) return;
    setError(null);
    const documentIds = sources.map((s) => s.documentId).filter((id) => selectedIds.includes(id));
    const itemCount = choice.noun ? count : undefined;
    const signature = JSON.stringify([kind, documentIds, itemCount]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    const idempotencyKey = attempt.current.key;
    startTransition(async () => {
      if (kind === "explain") {
        const result = await startNotebookExplainItAction({ projectId, documentIds, idempotencyKey });
        attempt.current = null;
        if (!result.ok) return setError(result.error);
        setSummary(result.summary);
      } else {
        const result = await makeNotebookLearningAction({
          projectId,
          kind,
          documentIds,
          count: itemCount,
          idempotencyKey,
        });
        attempt.current = null;
        if (!result.ok) return setError(result.error);
        trackGenerationJob(result.job);
        setSummary(null);
      }
      setOpen(false);
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
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Study from this notebook&apos;s sources with a quiz, flashcards or Explain It.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          Learn this
        </Button>
        <Link
          href={"/projects/" + projectId + "/notebook/graph"}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Open idea graph
        </Link>
      </div>
      {summary ? (
        <p role="status" className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {summary}
        </p>
      ) : null}
      <GenerationJobRows surface={surface} className="mt-3 text-body-dense" />

      <Sheet open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <SheetContent side="right" className="overflow-y-auto p-4">
          <SheetHeader className="p-0">
            <SheetTitle>Learn this</SheetTitle>
            <SheetDescription>
              {sources.length === 0 ? "No ready sources yet." : sourcesLine(selectedIds.length, sources.length)}
            </SheetDescription>
          </SheetHeader>
          <div role="radiogroup" aria-label="What to make" className="flex flex-col gap-1">
            {CHOICES.map((item) => (
              <label
                key={item.kind}
                className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-muted ${
                  kind === item.kind ? "bg-muted" : ""
                }`}
              >
                <input
                  type="radio"
                  name="learn-kind"
                  value={item.kind}
                  checked={kind === item.kind}
                  onChange={() => setKind(item.kind)}
                  className="mt-1"
                />
                <span className="min-w-0 text-body-dense font-medium">
                  {item.label}
                  <span className="block text-xs font-normal text-muted-foreground">{item.blurb}</span>
                </span>
              </label>
            ))}
          </div>
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-body-dense">Adjust</summary>
            <fieldset className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
              <legend className="sr-only">Sources</legend>
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
            {choice.noun ? (
              <label className="mt-3 flex items-center justify-between gap-2 text-xs">
                <span>How many {choice.noun}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_ITEM_COUNT}
                  max={MAX_ITEM_COUNT}
                  value={countText}
                  placeholder="Automatic"
                  onChange={(event) => setCountText(event.target.value)}
                  className="h-8 w-24 rounded-md border border-border bg-background px-2 text-body-dense"
                />
              </label>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">Explain It sets its own length.</p>
            )}
          </details>
          {problem ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
          {error ? <WorkStatus state={{ phase: "failed", label: error }} /> : null}
          <Button disabled={pending || problem !== null} onClick={create}>
            {pending ? "Starting…" : "Create"}
          </Button>
        </SheetContent>
      </Sheet>
    </section>
  );
}
