"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { makeNoteAction, makeTaskAction, setCaptureStateAction } from "./actions";
import { CaptureBody } from "./capture-body";
import { captureKindLabel, captureStateLabel, captureTitle, type InboxRow } from "./inbox-list";

/*
 * The detail pane: a view of the selected capture row (D12/D14). URL captures
 * render their URL as the content; text captures render the full body.
 * Actions are state-exact (D15): open shows Archive, discarded shows Restore
 * capture, converted shows the Work link only. The heading takes focus on
 * selection so keyboard and screen-reader users land in the pane they asked
 * for.
 */

const stamp = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Only http(s) may render as a live anchor; createCapture enforces this today, the render guard keeps it true regardless of future producers. */
function isHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:" || new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** "Oct 20, 3:42 PM" in the reader's zone, with the exact ISO kept in datetime. */
function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : stamp.format(date);
}

export function InboxDetail({
  capture,
}: {
  capture: (Omit<InboxRow, "preview"> & { text: string | null; failureReason?: string | null }) | null;
}) {
  const [optimisticState, decide] = useOptimistic(
    capture?.processingState ?? null,
    (_current: string | null, next: string) => next,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Seeded with the capture rendered on arrival: a page load with ?id= is not
  // a selection, so it must not steal focus, and the global :focus-visible
  // ring would otherwise frame the title like an input on first paint.
  const lastFocusedId = useRef<string | null>(capture?.id ?? null);
  useEffect(() => {
    if (capture && capture.id !== lastFocusedId.current) {
      lastFocusedId.current = capture.id;
      // A decision error belongs to the capture it failed on; selecting
      // another capture clears it rather than showing it under a new header.
      setError(null);
      headingRef.current?.focus();
    }
  }, [capture]);

  if (!capture) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center px-6">
        <p className="max-w-sm text-center text-[13px] text-muted-foreground">
          Select a capture to read it and decide what happens next.
        </p>
      </div>
    );
  }

  const state = optimisticState ?? capture.processingState;
  const isUrlOnly = !capture.text?.trim() && capture.url;
  const title = captureTitle(capture);

  function saveAsNote() {
    setError(null);
    startTransition(async () => {
      decide("converted");
      const result = await makeNoteAction({ captureId: capture!.id, expectedVersion: capture!.version });
      if (!result.ok) setError(result.error);
    });
  }

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
    <article className="mx-auto flex min-w-0 max-w-3xl flex-col">
      <header>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-balance text-2xl leading-tight break-words focus-visible:outline-none"
        >
          {capture.kind === "url" && capture.url && isHttpUrl(capture.url) ? (
            <a href={capture.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
              {capture.url}
            </a>
          ) : (
            title
          )}
        </h2>

        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="flex items-center gap-1.5 text-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-primary" />
            {captureStateLabel(state)}
          </dd>
          <dt className="text-muted-foreground">Kind</dt>
          <dd className="text-foreground">{captureKindLabel(capture.kind)}</dd>
          <dt className="text-muted-foreground">Captured</dt>
          <dd className="text-foreground">
            <time dateTime={capture.createdAt} suppressHydrationWarning>
              {when(capture.createdAt)}
            </time>
          </dd>
        </dl>
      </header>

      <div className="mt-6 border-border border-t pt-6">
        {isUrlOnly ? (
          capture.text ? (
            <CaptureBody
              captureId={capture.id}
              version={capture.version}
              text={capture.text}
              label="From the page"
              editable={state === "unprocessed" || state === "classifying"}
            />
          ) : capture.failureReason ? (
            <p className="max-w-[70ch] text-[13px] text-muted-foreground" role="status">
              {capture.failureReason}
            </p>
          ) : (
            <p className="max-w-[70ch] text-[13px] text-muted-foreground">
              Reading the page now. The text lands here when it arrives.
            </p>
          )
        ) : (
          <CaptureBody
            captureId={capture.id}
            version={capture.version}
            text={capture.text ?? ""}
            label={`Captured ${captureKindLabel(capture.kind).toLowerCase()}`}
            // The domain lets only an unprocessed or classifying capture be
            // edited: after conversion the derived task or note owns the text.
            editable={state === "unprocessed" || state === "classifying"}
          />
        )}
      </div>

      {error ? (
        <p className="mt-3 text-destructive text-[13px]" role="alert">{error}</p>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-2 border-border border-t pt-4">
        {state === "open" || state === "unprocessed" || state === "classifying" || state === "enriched" || state === "failed" ? (
          <>
            <Button size="sm" disabled={pending} onClick={saveAsNote}>
              Save as note
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => act("converted")}>
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
        {state === "converted" && capture.convertedType === "note" && capture.convertedId ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/alfred/notes?id=${encodeURIComponent(capture.convertedId)}`}>Open note</Link>
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
