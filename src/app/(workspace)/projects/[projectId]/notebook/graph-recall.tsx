"use client";

import { useState, useTransition } from "react";
import type { GraphEdge, GraphNode } from "@/domains/knowledge/relations";
import { RELATION_LABELS, RELATION_TYPES, type RelationType } from "@/domains/knowledge/relation-vocabulary";
import { submitNotebookGraphRecallAction } from "./graph-recall-action";

const CHOICES = RELATION_TYPES.filter((relation): relation is Exclude<RelationType, "source"> => relation !== "source");

export function NotebookGraphRecall({
  projectId,
  nodes,
  edges,
}: {
  projectId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}) {
  const verifiedEdges = edges.filter((edge) => CHOICES.includes(edge.linkType as Exclude<RelationType, "source">));
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState<Exclude<RelationType, "source"> | "">("");
  const [result, setResult] = useState<{ correct: boolean; expectedRelation: RelationType } | null>(null);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const edge = verifiedEdges[index];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = edge ? byId.get(edge.source) : null;
  const target = edge ? byId.get(edge.target) : null;

  function submit() {
    if (!edge || !selection) return;
    setError(null);
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    startTransition(async () => {
      const response = await submitNotebookGraphRecallAction({
        projectId,
        sourceArtifactId: edge.source,
        targetArtifactId: edge.target,
        submittedRelation: selection,
        requestKey: key,
      });
      if (!response.ok) {
        setError(response.error);
        setRequestKey(null);
        return;
      }
      setResult({ correct: response.correct, expectedRelation: response.expectedRelation });
    });
  }

  function next() {
    setIndex((current) => (current + 1) % verifiedEdges.length);
    setSelection("");
    setResult(null);
    setRequestKey(null);
    setError(null);
  }

  if (!edge || !source || !target) {
    return (
      <section className="rounded-xl border border-border p-5">
        <h2 className="font-medium">Reconstruct relationships</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This Notebook does not have verified idea links to practice yet. Connect ideas in the graph to create a recall
          exercise.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Relationship recall" className="rounded-xl border border-border p-5">
      <p className="text-xs text-muted-foreground">
        Reconstruct from memory · {index + 1} of {verifiedEdges.length}
      </p>
      <h2 className="mt-2 text-lg font-medium">
        How does “{source.title}” connect to “{target.title}”?
      </h2>
      {!result ? (
        <>
          <fieldset className="mt-4 grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Choose the relationship</legend>
            {CHOICES.map((relation) => (
              <label
                key={relation}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
              >
                <input
                  type="radio"
                  name="graph-relation"
                  value={relation}
                  checked={selection === relation}
                  onChange={() => setSelection(relation)}
                />
                {RELATION_LABELS[relation]}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={!selection || pending}
            onClick={submit}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Checking…" : "Check relationship"}
          </button>
        </>
      ) : (
        <div className="mt-4 rounded-lg bg-muted/50 p-4">
          <p className="font-medium">{result.correct ? "Correct" : "Review the link"}</p>
          <p className="mt-1 text-sm">{RELATION_LABELS[result.expectedRelation]}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            This exercise uses the Notebook’s saved relationship record. Your attempt is stored separately from that
            link.
          </p>
          <button
            type="button"
            onClick={next}
            className="mt-4 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Next relationship
          </button>
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
