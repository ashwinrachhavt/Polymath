"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * The generated-draft control under a run. A run with output and no artifact
 * yet offers "Save as draft"; a draft offers Keep (reviewed) and Discard
 * (archived); after that the row only states what happened. Saving a draft
 * never publishes it.
 */
export function DraftControls({
  runId,
  draft,
  canSave,
}: {
  runId: string;
  draft: { artifactId: string; status: string } | null;
  canSave: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `Request failed (${response.status}).`);
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setPending(false);
    }
  }

  if (!draft) {
    if (!canSave) return null;
    return (
      <div className="flex flex-col gap-1">
        <Button size="sm" variant="outline" className="w-fit" disabled={pending} onClick={() => call("/api/v1/drafts", { runId })}>
          Save the answer as a draft
        </Button>
        {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
      </div>
    );
  }
  if (draft.status === "reviewed") return <p className="text-muted-foreground text-xs">Saved as a Studio draft.</p>;
  if (draft.status === "archived") return <p className="text-muted-foreground text-xs">Draft discarded.</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => call(`/api/v1/drafts/${draft.artifactId}/save`)}>
          Keep the draft
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => call(`/api/v1/drafts/${draft.artifactId}/discard`)}>
          Discard
        </Button>
      </div>
      {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
