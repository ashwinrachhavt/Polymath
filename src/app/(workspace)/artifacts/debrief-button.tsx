"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ClipboardList } from "lucide-react";
import { debriefArtifactAction } from "./actions";

/*
 * "Debrief into proposals" on an artifact. One click runs the meeting
 * debrief: a batch of task, note and follow-up proposals lands in Reviews,
 * and the button reports how many are new there. A second click is a safe
 * retry - the batch dedupe keys keep the queue from doubling.
 */
export function DebriefButton({ artifactId }: { artifactId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  return (
    <span className="flex items-center gap-2">
      {message ? (
        <span className={failed ? "text-destructive" : "text-muted-foreground"} role={failed ? "alert" : "status"}>
          {message}
        </span>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setMessage(null);
          setFailed(false);
          startTransition(async () => {
            const result = await debriefArtifactAction({ artifactId });
            if (!result.ok) {
              setFailed(true);
              setMessage(result.error);
              return;
            }
            if (result.created === 0) {
              setMessage(result.deduplicated > 0 ? "Already in Reviews" : "Nothing to propose");
            } else {
              setMessage(`${result.created} proposal${result.created === 1 ? "" : "s"} in Reviews`);
              router.refresh();
            }
          });
        }}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
      >
        <ClipboardList aria-hidden className="size-3.5" />
        {pending ? "Debriefing…" : "Debrief into proposals"}
      </button>
    </span>
  );
}
