"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acceptCardAction, proposeCardAction, resumeCardAction, retireCardAction, suspendCardAction } from "./actions";

/*
 * The decision controls for one card, and the new-card form. One shared error
 * line: a decision that was already made (double-submit, stale tab) says so
 * and asks for a reload - it never silently "succeeds".
 */

function useDecision() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  return { pending, error, errorId, run };
}

function ErrorLine({ id, error }: { id: string; error: string | null }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-destructive text-xs">
      {error}
    </p>
  );
}

type ControlProps = { cardId: string; expectedVersion: number; state: "proposed" | "scheduled" | "suspended" | "retired" };

export function CardControls({ cardId, expectedVersion, state }: ControlProps) {
  const { pending, error, errorId, run } = useDecision();
  // One key per decision kind per mounted row: a retried click replays, a new
  // decision mints anew on refresh.
  const keys = useRef({ accept: crypto.randomUUID(), suspend: crypto.randomUUID(), resume: crypto.randomUUID(), retire: crypto.randomUUID() });
  const base = { cardId, expectedVersion };

  return (
    <span className="flex flex-wrap items-center gap-1.5" aria-describedby={error ? errorId : undefined}>
      {state === "proposed" && (
        <Button type="button" size="xs" disabled={pending} onClick={() => void run(() => acceptCardAction({ ...base, idempotencyKey: keys.current.accept }))}>
          Accept
        </Button>
      )}
      {state === "scheduled" && (
        <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => void run(() => suspendCardAction({ ...base, idempotencyKey: keys.current.suspend }))}>
          Suspend
        </Button>
      )}
      {state === "suspended" && (
        <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => void run(() => resumeCardAction({ ...base, idempotencyKey: keys.current.resume }))}>
          Resume
        </Button>
      )}
      {state !== "retired" && (
        <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void run(() => retireCardAction({ ...base, idempotencyKey: keys.current.retire }))}>
          Retire
        </Button>
      )}
      <ErrorLine id={errorId} error={error} />
    </span>
  );
}

export function NewCardForm({ sources }: { sources: Array<{ id: string; title: string; kind: string }> }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [artifactId, setArtifactId] = useState(sources[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // Minted once per filled form: a retried submit replays instead of
  // double-creating; a successfully created card resets the key with the form.
  const keyRef = useRef(crypto.randomUUID());

  if (sources.length === 0) return null;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await proposeCardAction({ prompt, answer, artifactId, idempotencyKey: keyRef.current });
      setPrompt("");
      setAnswer("");
      keyRef.current = crypto.randomUUID();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Prompt" placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} required />
        <Input aria-label="Answer" placeholder="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={4000} required />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Source note"
          className="border-input bg-background h-9 rounded-md border px-2 text-[13px]"
          value={artifactId}
          onChange={(e) => setArtifactId(e.target.value)}
        >
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.title}
            </option>
          ))}
        </select>
        <Button type="submit" size="xs" disabled={pending || !prompt.trim() || !answer.trim() || !artifactId}>
          Propose card
        </Button>
        <ErrorLine id={errorId} error={error} />
      </div>
    </form>
  );
}
