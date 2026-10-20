"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace/ui";
import { makeTaskAction, setCaptureStateAction } from "./actions";
import type { InboxRow } from "./inbox-list";

/*
 * The detail pane: a view of the selected capture row (D12/D14). URL captures
 * render their URL as the content; text captures render the full body.
 * Actions are state-exact (D15): open shows Archive, discarded shows Restore
 * capture, converted shows the Work link only. The heading takes focus on
 * selection so keyboard and screen-reader users land in the pane they asked
 * for.
 */

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + "Z";
}

/** Only http(s) may render as a live anchor; createCapture enforces this today, the render guard keeps it true regardless of future producers. */
function isHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:" || new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function InboxDetail({ capture }: { capture: (Omit<InboxRow, "preview"> & { text: string | null }) | null }) {
  const [optimisticState, decide] = useOptimistic(
    capture?.processingState ?? null,
    (_current: string | null, next: string) => next,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastFocusedId = useRef<string | null>(null);
  useEffect(() => {
    if (capture && capture.id !== lastFocusedId.current) {
      lastFocusedId.current = capture.id;
      headingRef.current?.focus();
    }
  }, [capture]);

  if (!capture) {
    return (
      <div className="panel-empty flex min-h-40 items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
        Select a capture to read it and decide what happens next.
      </div>
    );
  }

  const state = optimisticState ?? capture.processingState;
  const isUrlOnly = !capture.text?.trim() && capture.url;

  function act(next: "converted" | "discarded" | "unprocessed") {
    setError(null);
    startTransition(async () => {
      decide(next);
      const result =
        next === "converted"
          ? await makeTaskAction({ captureId: capture!.id, expectedVersion: capture!.version })
          : await setCaptureStateAction({ captureId: capture!.id, expectedVersion: capture!.version, state: next });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <article className="min-w-0">
      <header className="flex flex-wrap items-center gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-[13px] font-medium focus-visible:outline-none">
          {capture.kind === "url" && capture.url && isHttpUrl(capture.url) ? (
            <a href={capture.url} target="_blank" rel="noreferrer" className="readout break-all underline-offset-4 hover:underline">
              {capture.url}
            </a>
          ) : (
            "Capture"
          )}
        </h2>
      </header>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Status>{state}</Status>
        <span className="text-xs text-muted-foreground">{capture.kind}</span>
        <time className="readout text-xs text-muted-foreground" dateTime={capture.createdAt}>
          {when(capture.createdAt)}
        </time>
      </div>

      {isUrlOnly ? null : (
        <div className="mt-4 max-w-[70ch] whitespace-pre-wrap break-words text-[13px] leading-relaxed">
          {capture.text}
        </div>
      )}
      {isUrlOnly && capture.text === null ? (
        <p className="mt-4 max-w-[70ch] text-[13px] text-muted-foreground">
          This capture holds the URL only. Open the link to read the page.
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 text-destructive text-[13px]" role="alert">{error}</p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {state === "open" || state === "unprocessed" || state === "classifying" || state === "enriched" || state === "failed" ? (
          <>
            <Button size="sm" disabled={pending} onClick={() => act("converted")}>
              Make task
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("discarded")}>
              Archive
            </Button>
          </>
        ) : null}
        {state === "discarded" ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act("unprocessed")}>
            Restore capture
          </Button>
        ) : null}
        {state === "converted" && capture.convertedType === "task" && capture.convertedId ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/neuralflow/work?task=${encodeURIComponent(capture.convertedId)}`}>Open task in Work</Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}
