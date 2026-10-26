"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PenTool } from "lucide-react";
import { designBriefArtifactAction } from "./actions";

/*
 * "Design brief" on a research artifact (ASH-286, partial). One click drafts
 * a structured design brief as a new memo artifact and links to it. The
 * Canva handoff is not built yet, so the button never promises it - the
 * brief is the deliverable here.
 */
export function DesignBriefButton({ artifactId }: { artifactId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [briefId, setBriefId] = useState<string | null>(null);

  return (
    <span className="flex items-center gap-2">
      {message ? (
        <span className={failed ? "text-destructive" : "text-muted-foreground"} role={failed ? "alert" : "status"}>
          {message}
        </span>
      ) : null}
      {briefId ? (
        <a href={`/artifacts/${briefId}`} className="underline underline-offset-2 hover:text-foreground">
          Open brief
        </a>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setMessage(null);
          setFailed(false);
          startTransition(async () => {
            const result = await designBriefArtifactAction({ artifactId });
            if (!result.ok) {
              setFailed(true);
              setMessage(result.error);
              return;
            }
            setBriefId(result.briefArtifactId);
            setMessage("Brief drafted");
            router.refresh();
          });
        }}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
      >
        <PenTool aria-hidden className="size-3.5" />
        {pending ? "Drafting…" : "Design brief"}
      </button>
    </span>
  );
}
