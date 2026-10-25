"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { generateMeetingPrepAction } from "./meeting-prep-actions";

/*
 * "Prep" on a Next Events row (ASH-302). One click generates the meeting
 * prep report and turns into a link to it; regenerating before the meeting
 * is intentional, so the button stays usable after success.
 */
export function PrepButton({ eventId }: { eventId: string }) {
  const [pending, startTransition] = useTransition();
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      const result = await generateMeetingPrepAction({ eventId });
      if (result.ok) setArtifactId(result.artifactId);
      else setError(result.error);
    });
  };

  if (artifactId) {
    return (
      <span className="flex shrink-0 items-center gap-2 text-xs">
        {error ? <span role="alert" className="text-destructive">{error}</span> : null}
        <Link href={`/artifacts/${artifactId}`} className="underline underline-offset-2 hover:text-foreground">
          Prep ready
        </Link>
        <button
          type="button"
          disabled={pending}
          onClick={run}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {pending ? "Refreshing…" : "Refresh"}
        </button>
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-2 text-xs">
      {error ? <span role="alert" className="text-destructive">{error}</span> : null}
      <button
        type="button"
        disabled={pending}
        onClick={run}
        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
      >
        {pending ? "Prepping…" : "Prep"}
      </button>
    </span>
  );
}
