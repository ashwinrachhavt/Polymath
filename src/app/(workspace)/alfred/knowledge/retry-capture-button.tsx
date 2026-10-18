"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { captureUrlAction } from "./actions";

/*
 * Re-fetch a captured page whose first fetch never landed (the row has no
 * file and no extraction). captureUrl retries on the same document, so the
 * stuck row heals in place instead of duplicating.
 */
export function RetryCaptureButton({ url }: { url: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setPending(true);
    setError(null);
    try {
      const result = await captureUrlAction(url);
      if (!result.ok) throw new Error(result.message);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fetch failed again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="sm" variant="outline" onClick={retry} disabled={pending} className="w-fit">
        {pending ? "Fetching…" : "Retry fetch"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
