"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * The one mutation on this page: an objective becomes a run. The POST goes to
 * /api/v1/runs, whose engine claims the budget before the session starts.
 * On success the router refresh lands the new run in the server-rendered list.
 */
export function StartRunForm() {
  const router = useRouter();
  const [objective, setObjective] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `Run failed to start (${response.status}).`);
      }
      setObjective("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run failed to start.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="objective" className="sr-only">
        What should Alfred do?
      </label>
      <textarea
        id="objective"
        rows={3}
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        placeholder="Describe an objective. Alfred proposes; you approve anything that leaves Axiom."
        className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3"
      />
      <Button onClick={start} disabled={pending || objective.trim().length === 0} className="w-fit">
        {pending ? "Starting…" : "Start a run"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
