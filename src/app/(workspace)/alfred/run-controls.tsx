"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/client-request";

/*
 * The controls under one run's thread. Live runs take a follow-up and can be
 * cancelled; finished runs can only be retried (which starts a new run). Every
 * action posts to the run's API route and then refreshes the server-rendered
 * thread, so the page never holds thread state of its own. The idempotency
 * key makes a retry after a network timeout apply once.
 */
export function RunControls({ runId, finished }: { runId: string; finished: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown) {
    setPending(true);
    setError(null);
    const result = await requestJson(`/api/v1/runs/${runId}/${path}`, {
      method: "POST",
      body,
      idempotencyKey: crypto.randomUUID(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.failure.title);
      return;
    }
    setMessage("");
    router.refresh();
  }

  if (finished) {
    // One quiet text action on the transcript's edge: a finished run's only job
    // here is retry, and a button-sized control read as a second composer.
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => call("retry")}
          className="text-muted-foreground hover:text-foreground w-fit rounded text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Retry as a new run
        </button>
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
          Stop
        </Button>
      </div>
      {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
