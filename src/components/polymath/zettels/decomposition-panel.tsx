"use client";

import { useState } from "react";
import type { DecompositionAnalysis, DecompositionCandidate, DecompositionDecision } from "@/domains/knowledge/decomposition";

/*
 * The decomposition review panel (§14.6): the paste's proposed extractions
 * with their verbatim quotes, the omitted material with its reasons, and the
 * four honest decisions per candidate - create, merge into a similar card,
 * link to a similar card, skip. Similarity matches are shown, never asserted
 * (§4): merge/link targets are always the reviewer's explicit pick.
 */

type Choice =
  | { action: "skip" }
  | { action: "create" }
  | { action: "merge"; targetArtifactId: string }
  | { action: "link"; targetArtifactId: string };

const ROLE_LABELS: Record<DecompositionCandidate["role"], string> = {
  principle: "Idea card",
  decision: "Note",
  checklist: "Task",
};

function CandidateCard({
  candidate,
  choice,
  onChoose,
}: {
  candidate: DecompositionCandidate;
  choice: Choice;
  onChoose: (choice: Choice) => void;
}) {
  return (
    <li className="rounded border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{candidate.title}</span>
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
          {ROLE_LABELS[candidate.role]}
          {candidate.kind === "synthesis" ? " · synthesis" : ""}
        </span>
      </div>
      <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{candidate.content}</p>
      <blockquote className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
        {candidate.spans.map((span) => (
          <p key={`${span.start}-${span.end}`}>{span.quote}</p>
        ))}
      </blockquote>
      {candidate.similar.length > 0 && (
        <div className="mt-2 rounded bg-muted/50 p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Possibly related - your call</p>
          <ul className="mt-1 space-y-1">
            {candidate.similar.map((match) => (
              <li key={match.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{match.title}</span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className={`min-h-11 rounded border px-2 text-xs ${choice.action === "merge" && choice.targetArtifactId === match.id ? "border-foreground" : "border-border"}`}
                    onClick={() => onChoose({ action: "merge", targetArtifactId: match.id })}
                  >
                    Merge in
                  </button>
                  <button
                    type="button"
                    className={`min-h-11 rounded border px-2 text-xs ${choice.action === "link" && choice.targetArtifactId === match.id ? "border-foreground" : "border-border"}`}
                    onClick={() => onChoose({ action: "link", targetArtifactId: match.id })}
                  >
                    Create + link
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={`min-h-11 flex-1 rounded border px-3 text-sm ${choice.action === "create" ? "border-foreground font-medium" : "border-border"}`}
          onClick={() => onChoose({ action: "create" })}
        >
          Create new
        </button>
        <button
          type="button"
          className={`min-h-11 rounded border px-3 text-sm ${choice.action === "skip" ? "border-foreground" : "border-border"} text-muted-foreground`}
          onClick={() => onChoose({ action: "skip" })}
        >
          Skip
        </button>
      </div>
    </li>
  );
}

export function DecompositionPanel({
  analysis,
  committing,
  onCommit,
  onDismiss,
}: {
  analysis: DecompositionAnalysis;
  committing: boolean;
  onCommit: (decisions: DecompositionDecision[]) => void;
  onDismiss: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const decisions: DecompositionDecision[] = analysis.candidates.map((candidate) => {
    const choice = choices[candidate.id] ?? { action: "skip" as const };
    return { candidateId: candidate.id, ...choice } as DecompositionDecision;
  });
  const decided = decisions.filter((d) => d.action !== "skip").length;
  return (
    <aside aria-label="Paste extraction review" className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-4 max-lg:border-l-0 max-lg:border-t">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Review extractions</h2>
        <button type="button" className="min-h-11 px-2 text-sm text-muted-foreground underline" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Your pasted text stays as-is in the editor. Nothing below exists yet - choose what becomes a card, note or task.
      </p>
      <ul className="space-y-3">
        {analysis.candidates.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            choice={choices[candidate.id] ?? { action: "skip" }}
            onChoose={(choice) => setChoices((prev) => ({ ...prev, [candidate.id]: choice }))}
          />
        ))}
      </ul>
      {analysis.omitted.length > 0 && (
        <div className="rounded border border-dashed border-border p-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Left out, with reasons</p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {analysis.omitted.map((omission, i) => (
              <li key={i}>
                <span className="italic">&ldquo;{omission.quote.slice(0, 80)}{omission.quote.length > 80 ? "…" : ""}&rdquo;</span> - {omission.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        disabled={committing || decided === 0}
        className="min-h-11 rounded bg-foreground px-3 text-sm text-background disabled:opacity-40"
        onClick={() => onCommit(decisions)}
      >
        {committing ? "Committing…" : `Commit ${decided} decision${decided === 1 ? "" : "s"}`}
      </button>
    </aside>
  );
}
