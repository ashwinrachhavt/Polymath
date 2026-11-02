"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissDecisionAction } from "@/app/(workspace)/supervision/actions";

/**
 * Dismisses one unavailable Decision through the Engine — the sole writer
 * of domain state — and refreshes the panel. The dismiss action is the
 * server boundary; this button only carries the person's decision to it.
 */
export function DismissButton({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await dismissDecisionAction(decisionId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setError(null);
            router.refresh();
          })
        }
        className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-2 py-1 text-xs outline-none disabled:opacity-50"
      >
        {pending ? "Dismissing…" : "Dismiss"}
      </button>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </span>
  );
}
