"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { generateLearningPathAction } from "./actions";

/*
 * "Learning path" (ASH-300): name a goal ("understand X") and one pass
 * proposes the whole sequence - notes and practice tasks into Reviews,
 * recall cards here in the proposed state, all citing the path note it
 * writes. A retry replays the same proposals instead of doubling them.
 */
export function LearningPathForm() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await generateLearningPathAction({ goal });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          router.push(`/artifacts/${result.artifactId}`);
        });
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor="learning-path-goal" className="text-[13px]">
        Learning goal
      </label>
      <input
        id="learning-path-goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        placeholder="understand distributed consensus"
        aria-describedby={error ? errorId : undefined}
        className="h-8 rounded-md border border-border bg-transparent px-2 text-[13px] outline-none"
      />
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          disabled={pending || !goal.trim()}
          className="rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted disabled:opacity-50"
        >
          {pending ? "Proposing…" : "Propose learning path"}
        </button>
      </div>
    </form>
  );
}
