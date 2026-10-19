"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { acceptOutcomeAction, replaceOutcomeAction } from "./actions";

/* Outcome buttons: a tag patch on the canonical task, version-checked. */

export function OutcomeButton({
  taskId,
  version,
  tags,
  outcomeTag,
  mode,
}: {
  taskId: string;
  version: number;
  tags: string[];
  outcomeTag: string;
  mode: "accept" | "replace";
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Instant feedback on the click; the version-checked action is the final
  // word, so a conflict or failure flips this back as the transition settles.
  const [decided, setDecided] = useOptimistic(false);
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending || decided}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            setDecided(true);
            const action = mode === "accept" ? acceptOutcomeAction : replaceOutcomeAction;
            const result = await action({ taskId, expectedVersion: version, tags, outcomeTag });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {decided ? (mode === "accept" ? "Outcome accepted" : "Outcome replaced") : mode === "accept" ? "Accept outcome" : "Replace outcome"}
      </Button>
      {error ? <span className="text-destructive text-xs" role="alert">{error}</span> : null}
    </span>
  );
}
