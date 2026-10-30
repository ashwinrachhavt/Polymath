"use client";

import { useState, useTransition } from "react";
import { pinArtifactAction, unpinArtifactAction } from "./actions";

/*
 * Pin controls for one day page. The daybook has one write, so the island
 * stays this small: pin an artifact to the day, or remove a pin. Refused
 * writes say so — never a fake saved state (agents/frontend.md).
 *
 * With one candidate the dropdown collapses to the mockup's inline "Keep"
 * button: one click, one target. With several it stays a picker.
 */
export function PinControls({
  localDate,
  candidates,
}: {
  localDate: string;
  candidates: Array<{ id: string; title: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState("");

  if (!candidates.length) return null;
  const single = candidates.length === 1 ? candidates[0] : null;

  function pin(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await pinArtifactAction({ localDate, artifactId: id });
      if (!result.ok) setError(result.error);
      else setArtifactId("");
    });
  }

  if (single) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => pin(single.id)}
          className="-my-1 inline-flex items-center px-1.5 py-1 text-xs text-muted-foreground hover:underline disabled:opacity-50"
        >
          {pending ? "Pinning…" : "Keep"}
        </button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={artifactId}
        onChange={(event) => setArtifactId(event.target.value)}
        className="text-[13px] rounded-md border border-border bg-transparent px-2 py-1"
        aria-label="Pin a record to this day"
      >
        <option value="">Pin a record…</option>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!artifactId || pending}
        onClick={() => {
          if (!artifactId) return;
          pin(artifactId);
        }}
        className="text-[13px] rounded-md border border-border px-2 py-1 disabled:opacity-50"
      >
        {pending ? "Pinning…" : "Pin"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export function UnpinButton({ localDate, artifactId }: { localDate: string; artifactId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await unpinArtifactAction({ localDate, artifactId });
            if (!result.ok) setError(result.error);
          });
        }}
        className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
