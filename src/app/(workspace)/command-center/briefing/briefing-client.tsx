"use client";

import { useState, useTransition } from "react";
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
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const action = mode === "accept" ? acceptOutcomeAction : replaceOutcomeAction;
            const result = await action({ taskId, expectedVersion: version, tags, outcomeTag });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {mode === "accept" ? "Accept outcome" : "Replace outcome"}
      </Button>
      {error ? <span className="text-destructive text-xs" role="alert">{error}</span> : null}
    </span>
  );
}
