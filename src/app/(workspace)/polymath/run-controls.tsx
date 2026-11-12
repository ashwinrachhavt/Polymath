"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/lib/client-request";
import { randomId } from "@/lib/random-id";

/*
 * The control under a finished run's thread. A live run's next message goes
 * through the composer, and cancellation is not offered: the old stop control
 * posted to an endpoint whose result never reached this surface, so it read as
 * a button that did nothing. A finished run's only job here is retry, which
 * starts a new run; that posts to the API and refreshes the server-rendered
 * thread, so the page never holds thread state of its own. The idempotency key
 * makes a retry after a network timeout apply once.
 */
export function RunControls({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setPending(true);
    setError(null);
    const result = await requestJson(`/api/v1/runs/${runId}/retry`, {
      method: "POST",
      idempotencyKey: randomId(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.failure.title);
      return;
    }
    router.refresh();
  }

  // One quiet text action on the transcript's edge: a finished run's only job
  // here is retry, and a button-sized control read as a second composer.
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={retry}
        className="text-muted-foreground hover:text-foreground w-fit rounded text-label outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        Retry as a new run
      </button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
