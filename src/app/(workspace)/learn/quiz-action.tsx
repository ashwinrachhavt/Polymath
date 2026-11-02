"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { generateQuizAction } from "./actions";

/*
 * The one interactive control the library and the quiz shell share: start a
 * generation, then either open the runner (library) or re-read the shell
 * (regenerate, where latest ready wins). Pending and errors follow the
 * claim-button pattern: useTransition, disabled while pending, inline
 * role="alert" with the action's authored copy - no toasts, because the
 * repo has none.
 */
export function GenerateQuizButton({
  documentId,
  label = "Generate quiz",
  afterGenerate = "push",
  disabled = false,
}: {
  documentId: string;
  label?: string;
  afterGenerate?: "push" | "refresh";
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        disabled={disabled || pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await generateQuizAction(documentId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            if (afterGenerate === "push") router.push(`/learn/${documentId}`);
            else router.refresh();
          });
        }}
      >
        {pending ? "Generating…" : label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
