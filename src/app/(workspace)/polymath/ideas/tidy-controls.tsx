"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TidyResolution } from "@/domains/knowledge/tidy";
import { dismissFindingAction, resolveDisagreementAction, runTidyNowAction, type TidyDecisionResult } from "./actions";

/*
 * The interactive half of the Tidy section. Each control states what it is
 * doing while the server works and says plainly when it could not; a row
 * leaves the list only after the server refreshed it.
 */

const NETWORK_ERROR = "Could not reach the server. Try again.";

function useDecision() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (call: () => Promise<TidyDecisionResult>) => {
    setError(null);
    start(async () => {
      try {
        const result = await call();
        if (!result.ok) setError(result.error);
      } catch {
        setError(NETWORK_ERROR);
      }
    });
  };
  return { pending, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-destructive text-xs">
      {error}
    </p>
  ) : null;
}

const OUTCOMES: Array<{ outcome: TidyResolution; label: string }> = [
  { outcome: "first_holds", label: "First holds" },
  { outcome: "second_holds", label: "Second holds" },
  { outcome: "both_hold", label: "Both hold" },
];

export function DisagreementDecision({ findingId }: { findingId: string }) {
  const { pending, error, run } = useDecision();
  const [note, setNote] = useState("");
  const noteId = useId();
  const trimmed = note.trim();
  return (
    <div className="flex flex-col gap-2" aria-busy={pending}>
      <label htmlFor={noteId} className="text-xs text-muted-foreground">
        Why? (optional)
      </label>
      <Textarea
        id={noteId}
        value={note}
        maxLength={500}
        disabled={pending}
        onChange={(event) => setNote(event.target.value)}
        className="min-h-12"
      />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which idea holds">
        {OUTCOMES.map(({ outcome, label }) => (
          <Button
            key={outcome}
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(() => resolveDisagreementAction({ findingId, outcome, ...(trimmed ? { note: trimmed } : {}) }))
            }
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => dismissFindingAction({ findingId }))}
        >
          Not a disagreement
        </Button>
      </div>
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Saving…
        </p>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

export function DismissFinding({ findingId, label }: { findingId: string; label: string }) {
  const { pending, error, run } = useDecision();
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => run(() => dismissFindingAction({ findingId }))}
      >
        {pending ? "Saving…" : label}
      </Button>
      <ErrorLine error={error} />
    </span>
  );
}

export function TidyNowButton() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setMessage(null);
          setError(null);
          start(async () => {
            try {
              setMessage((await runTidyNowAction()).message);
            } catch {
              setError("Tidy could not finish. Try again.");
            }
          });
        }}
      >
        {pending ? "Tidying…" : "Tidy now"}
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {message}
      </span>
      <ErrorLine error={error} />
    </span>
  );
}
