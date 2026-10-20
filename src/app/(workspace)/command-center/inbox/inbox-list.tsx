"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace/ui";
import { makeTaskAction, setCaptureStateAction } from "./actions";

/*
 * Optimistic clarify loop: a row leaves the current filtered view the moment
 * it is decided, and the server action's version check is the final word - a
 * conflict or failure returns the row as the transition settles (useOptimistic
 * reverts to the base state), with the error pinned to the row.
 */

export type InboxRow = {
  id: string;
  processingState: string;
  kind: string;
  createdAt: string;
  text: string | null;
  url: string | null;
  version: number;
  convertedType: string | null;
  convertedId: string | null;
};

export type InboxView = "unprocessed" | "converted" | "discarded" | "all";

type Decision = { id: string; next: "converted" | "discarded" | "unprocessed" };

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + "Z";
}

export function InboxList({ rows, view }: { rows: InboxRow[]; view: InboxView }) {
  // In "all" a decided row stays visible with its new state; in the filtered
  // views it leaves the list. Both are one reducer on the same decision.
  const [optimisticRows, decide] = useOptimistic(rows, (current: InboxRow[], decision: Decision) =>
    view === "all"
      ? current.map((row) => (row.id === decision.id ? { ...row, processingState: decision.next } : row))
      : current.filter((row) => row.id !== decision.id),
  );
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function act(row: InboxRow, next: Decision["next"]) {
    setError(null);
    startTransition(async () => {
      decide({ id: row.id, next });
      const result =
        next === "converted"
          ? await makeTaskAction({ captureId: row.id, expectedVersion: row.version })
          : await setCaptureStateAction({ captureId: row.id, expectedVersion: row.version, state: next });
      if (!result.ok) setError({ id: row.id, message: result.error });
    });
  }

  return (
    <div className="divide-y divide-border">
      {optimisticRows.map((capture) => {
        const state =
          capture.processingState === "converted" ? "converted" : capture.processingState === "discarded" ? "discarded" : "open";
        return (
          <article key={capture.id} className="py-4 first:pt-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Status>{capture.processingState}</Status>
              <span className="text-xs text-muted-foreground">{capture.kind}</span>
              <time className="readout text-xs text-muted-foreground" dateTime={capture.createdAt}>
                {when(capture.createdAt)}
              </time>
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px]">{capture.text ?? capture.url}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {state === "open" ? (
                <>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => act(capture, "converted")}>
                    Make task
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(capture, "discarded")}>
                    Archive
                  </Button>
                </>
              ) : null}
              {state === "discarded" ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(capture, "unprocessed")}>
                  Restore capture
                </Button>
              ) : null}
              {error?.id === capture.id ? (
                <p className="text-destructive text-[13px]" role="alert">{error.message}</p>
              ) : null}
            </div>
            {capture.processingState === "converted" && capture.convertedType === "task" && capture.convertedId ? (
              <Button asChild className="mt-3" size="sm" variant="outline">
                <Link href={`/neuralflow/work?task=${encodeURIComponent(capture.convertedId)}`}>Open task in Work</Link>
              </Button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
