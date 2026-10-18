"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * Run extraction for a document — first read for one still waiting, retry for
 * one that failed. The route is idempotent by content hash, so re-running
 * either runs the provider or returns the stored text — never a duplicate
 * extraction row.
 */
export function RetryExtractionButton({
  documentId,
  label,
}: {
  documentId: string;
  /** "Read now" for a document with no extraction yet, "Retry" for a failed one. */
  label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/extract`, { method: "POST" });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `Extraction failed (${response.status}).`);
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Extraction failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" onClick={retry} disabled={pending} className="w-fit">
        {pending ? "Reading…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
