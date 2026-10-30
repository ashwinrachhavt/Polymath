"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/client-request";

/*
 * The generated-draft control under a run. A draft offers Keep (reviewed) and
 * Discard (archived); after that the row only states what happened. Keeping a
 * draft never publishes it.
 */
export function DraftControls({
  draft,
}: {
  draft: { artifactId: string; status: string; version: number } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown) {
    setPending(true);
    setError(null);
    const result = await requestJson(path, { method: "POST", body, idempotencyKey: crypto.randomUUID() });
    setPending(false);
    if (!result.ok) {
      setError(result.failure.title);
      return;
    }
    router.refresh();
  }

  if (!draft) return null;
  if (draft.status === "reviewed")
    return (
      <p className="text-muted-foreground text-xs">
        Kept as a reviewed Studio draft · version {draft.version} ·{" "}
        <a href={`/polymath/dossiers?draft=${draft.artifactId}`} className="underline underline-offset-2 hover:text-foreground">
          Open it
        </a>
      </p>
    );
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
