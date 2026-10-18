"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * The controls under one run's thread. Live runs take a follow-up and can be
 * cancelled; finished runs can only be retried (which starts a new run). Every
 * action posts to the run's API route and then refreshes the server-rendered
 * thread, so the page never holds thread state of its own.
 */
export function RunControls({ runId, finished }: { runId: string; finished: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/runs/${runId}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `Request failed (${response.status}).`);
      }
      setMessage("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setPending(false);
    }
  }

  if (finished) {
    return (
      <div className="flex flex-col gap-1">
        <Button size="sm" variant="outline" className="w-fit" disabled={pending} onClick={() => call("retry")}>
          Retry as a new run
        </Button>
        {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`follow-${runId}`} className="sr-only">Follow-up message</label>
      <div className="flex gap-2">
        <input
          id={`follow-${runId}`}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Send a follow-up"
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
        <Button size="sm" disabled={pending || message.trim().length === 0} onClick={() => call("messages", { message })}>
          Send
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => call("cancel")}>
          Cancel
        </Button>
      </div>
      {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
