"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Palette } from "lucide-react";
import { proposeCanvaImportAction } from "./actions";

/*
 * "Send to Canva" on a generated design brief (ASH-286 handoff). One click
 * files a canva.design.import proposal; nothing imports here - the owner
 * approves the exact revision in Reviews, and Canva's import job settles
 * through reconciliation. A repeat click resolves the same proposal.
 */
export function CanvaImportButton({ artifactId }: { artifactId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [proposed, setProposed] = useState(false);

  return (
    <span className="flex flex-wrap items-center gap-2">
      {message ? (
        <span className={failed ? "text-destructive" : "text-muted-foreground"} role={failed ? "alert" : "status"}>
          {message}
        </span>
      ) : null}
      {proposed ? (
        <a href="/reviews" className="underline underline-offset-2 hover:text-foreground">
          Review in Reviews
        </a>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setMessage(null);
          setFailed(false);
          startTransition(async () => {
            const result = await proposeCanvaImportAction({ artifactId });
            if (!result.ok) {
              setFailed(true);
              setMessage(result.error);
              return;
            }
            setProposed(true);
            setMessage(result.deduplicated ? "Import already proposed" : "Import proposed");
            router.refresh();
          });
        }}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
      >
        <Palette aria-hidden className="size-3.5" />
        {pending ? "Proposing…" : "Send to Canva"}
      </button>
    </span>
  );
}
