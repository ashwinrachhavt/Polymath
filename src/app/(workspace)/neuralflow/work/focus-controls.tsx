"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { startSessionAction } from "./actions";

/*
 * The task detail's Focus action. One click starts a task-linked session and
 * lands on Focus, where the live session's controls live now (the screen
 * absorbed ActiveSessionControls - Work no longer renders them).
 */
export function FocusTaskButton({ task }: { task: { id: string; title: string } }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await startSessionAction({ subject: task.title, plannedMinutes: null, taskId: task.id });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push("/neuralflow/focus");
          });
        }}
      >
        Start focus
      </Button>
      {error ? (
        <p className="text-destructive max-w-56 text-right text-xs leading-relaxed" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
