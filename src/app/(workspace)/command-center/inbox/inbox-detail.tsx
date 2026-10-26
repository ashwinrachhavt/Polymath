"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { acceptProposalAction, makeDraftAction, makeDocumentAction,
  makeNoteAction, makeTaskAction, rejectProposalAction, retryCaptureUrlAction, setCaptureStateAction, unparkCaptureAction } from "./actions";
import { DRAFT_TEMPLATES, DRAFT_TEMPLATE_LABEL, type DraftTemplate } from "@/domains/knowledge/templates";
import type { PriorWriting } from "@/domains/knowledge/prior-writing";
import { Sparkles } from "lucide-react";
import { CaptureBody } from "./capture-body";
import { captureDetailHeading, captureKindLabel, captureStateLabel, captureTitle, type InboxRow } from "./inbox-list";

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

const PRIOR_KIND_LABEL: Record<string, string> = {
  zettel: "Zettel",
  note: "Note",
  draft: "Draft",
  report: "Report",
  memo: "Memo",
  transcript: "Conversation",
};

function priorKindLabel(kind: string): string {
  return PRIOR_KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

export type CaptureSuggestion = {
  id: string;
  kind: string;
  rationale: string | null;
  confidence: string | null;
};

/*
 * What the system's read offers (ASH-314). Accept runs the same conversion
 * the manual buttons run; the manual row stays because classification is
 * always secondary - the owner decides, the suggestion only saves a step.
 * A contact suggestion carries no fields to build a record from, so it
 * points at the CRM surface instead of pretending to create one.
 */
const SUGGESTION_COPY: Record<string, { label: string; accept: string }> = {
  task: { label: "Looks like a task", accept: "Make task" },
  note: { label: "Looks like a note", accept: "Save as note" },
  contact: { label: "Looks like someone new", accept: "" },
  discard: { label: "Looks safe to archive", accept: "Archive" },
};

/** "0.87" reads as "87% sure"; the review-band "low" stays words. */
function confidenceLabel(confidence: string | null): string | null {
  if (!confidence) return null;
  const value = Number.parseFloat(confidence);
  if (Number.isNaN(value)) return `${confidence} confidence`;
  return `${Math.round(value * 100)}% sure`;
}

/**
 * The fetch outcomes that mean the page was not read and asking again could
 * change that. `acquired` speaks for itself; `pending` is a read in flight.
 */
const FETCH_FAILURES = new Set(["error-page", "access-denied", "empty", "provider-unavailable"]);

export function InboxDetail({
  capture,
  priorWriting,
  proposals = [],
}: {
  proposals?: CaptureSuggestion[];
  capture: (Omit<InboxRow, "preview"> & {
    text: string | null;
    cleanText?: string | null;
    failureReason?: string | null;
    /**
     * What the page fetch produced (ed97a9b): null until a fetch is attempted,
     * so a caller that does not pass it reads the legacy way - a reason on a
     * capture with no text of its own means the page was not read.
     */
    fetchOutcome?: string | null;
    rawPayload?: unknown;
  }) | null;
  /** What the workspace already holds about this capture's URL; null for non-URL captures. */
  priorWriting?: PriorWriting | null;
}) {
  const [optimisticState, decide] = useOptimistic(
    capture?.processingState ?? null,
    (_current: string | null, next: string) => next,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Decided suggestions leave the card immediately; a failed decision puts
  // the id back so the offer is not lost to a transient error. Selecting
  // another capture resets the set during render (React's documented pattern
  // for derive-on-prop-change) rather than in an effect.
  const [decidedSuggestions, setDecidedSuggestions] = useState<Set<string>>(new Set());
  const [suggestionsFor, setSuggestionsFor] = useState<string | null>(capture?.id ?? null);
  if ((capture?.id ?? null) !== suggestionsFor) {
    setSuggestionsFor(capture?.id ?? null);
    setDecidedSuggestions(new Set());
  }
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

  const suggestions =
    capture && ["open", "unprocessed", "classifying", "enriched", "failed"].includes(capture.processingState)
      ? proposals.filter((proposal) => !decidedSuggestions.has(proposal.id))
      : [];
  // A voice note without its transcript yet has no words to convert (ASH-298).
  const voiceWithoutTranscript = capture?.kind === "voice" && !(capture.cleanText ?? capture.text)?.trim();

  function decideSuggestion(suggestion: CaptureSuggestion, decision: "accept" | "reject") {
    setError(null);
    setDecidedSuggestions((current) => new Set(current).add(suggestion.id));
    startTransition(async () => {
      const run = decision === "accept" ? acceptProposalAction : rejectProposalAction;
      const result = await run({ proposalId: suggestion.id });
      if (!result.ok) {
        setDecidedSuggestions((current) => {
          const next = new Set(current);
          next.delete(suggestion.id);
          return next;
        });
        setError(result.error);
      }
    });
  }

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
  // A name only when one exists apart from the body; an unlabeled text capture
  // renders its body directly instead of the derived first line twice.
  const heading = captureDetailHeading(capture);
  /*
   * A page that was not read says why, and only a read that can be repeated is
   * offered again. `fetchOutcome` is the record of the attempt (ed97a9b); a
   * retained reason on a capture with no text of its own is the same fact for
   * a caller that has not passed the outcome through, because enrichment
   * clears the reason as soon as any text exists.
   */
  const fetchFailed =
    capture.fetchOutcome !== undefined && capture.fetchOutcome !== null
      ? FETCH_FAILURES.has(capture.fetchOutcome)
      : Boolean(capture.failureReason);
  const captureId = capture.id;

  function retryFetch() {
    setError(null);
    startTransition(async () => {
      const result = await retryCaptureUrlAction({ captureId });
      if (!result.ok) setError(result.error);
    });
  }

  function saveAsDocument() {
    setError(null);
    startTransition(async () => {
      decide("converted");
      const result = await makeDocumentAction({ captureId: capture!.id, expectedVersion: capture!.version });
      if (!result.ok) setError(result.error);
    });
  }

  function saveAsNote() {
    setError(null);
    startTransition(async () => {
      decide("converted");
      const result = await makeNoteAction({ captureId: capture!.id, expectedVersion: capture!.version });
      if (!result.ok) setError(result.error);
    });
  }

  function saveAsDraft(template: DraftTemplate) {
    setError(null);
    startTransition(async () => {
      decide("converted");
      const result = await makeDraftAction({ captureId: capture!.id, expectedVersion: capture!.version, template });
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
        {heading ? (
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-balance text-[17px] leading-snug font-medium break-words focus-visible:outline-none"
          >
            {heading}
          </h2>
        ) : null}
        {/* The address a capture came from, shown whenever it is not already
            the heading or the body. A selection keeps the person's words as
            its text and the page as its origin, so the URL is the provenance
            line rather than the content. */}
        {capture.url && isHttpUrl(capture.url) && capture.url !== (heading ?? title) ? (
          <a
            href={capture.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground mt-0.5 block truncate text-xs underline-offset-4 hover:underline"
          >
            {capture.url}
          </a>
        ) : null}

        {/* One meta line, not a definition grid: state, kind, captured. The dot
            carries "state can change"; the words carry which state. */}
        <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
          {capture.parkedAt ? (
            <>
              <span className="text-foreground">Parked</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="text-foreground">{captureStateLabel(state)}</span>
          <span aria-hidden>·</span>
          <span>{captureKindLabel(capture.kind)}</span>
          <span aria-hidden>·</span>
          <time dateTime={capture.createdAt} suppressHydrationWarning>
            {when(capture.createdAt)}
          </time>
        </p>
      </header>

      {/* Keyed by capture id: CaptureBody holds the draft and a Tiptap editor
          in mount-time state, and switching captures in place kept the previous
          capture's text under the new one's title. A new id remounts the body. */}
      <div key={capture.id} className="mt-6 border-border border-t pt-6">
        {capture.kind === "file" ? (
          <FileCapturePanel captureId={capture.id} rawPayload={capture.rawPayload} />
        ) : isUrlOnly ? (
          capture.text ? (
            <CaptureBody
              captureId={capture.id}
              version={capture.version}
              text={capture.text}
              label="From the page"
              editable={state === "unprocessed" || state === "classifying"}
            />
          ) : fetchFailed ? (
            <div className="max-w-[70ch]" role="status">
              <p className="text-[13px] text-muted-foreground">
                {capture.failureReason ?? "The page could not be read."}
              </p>
              <Button className="mt-2" size="sm" variant="outline" disabled={pending} onClick={retryFetch}>
                Retry
              </Button>
            </div>
          ) : capture.fetchOutcome === "acquired" ? null : (
            <p className="max-w-[70ch] text-[13px] text-muted-foreground">
              Reading the page now. The text lands here when it arrives.
            </p>
          )
        ) : (
          <>
            {/* A capture whose words never arrived says why above its (empty)
                body. A voice note already says it in the hint beside the
                actions, so this stays out of its way rather than printing the
                same sentence twice. */}
            {capture.failureReason && !voiceWithoutTranscript ? (
              <p className="mb-3 max-w-[70ch] text-[13px] text-muted-foreground" role="status">
                {capture.failureReason}
              </p>
            ) : null}
            <CaptureBody
              captureId={capture.id}
              version={capture.version}
              text={capture.text ?? ""}
              label={capture.kind === "voice" ? "Voice note" : `Captured ${captureKindLabel(capture.kind).toLowerCase()}`}
              // Only conversion closes editing: an enriched capture's words are
              // still the owner's working text (an edit re-runs classification);
              // after conversion the derived task or note owns the text.
              editable={state === "unprocessed" || state === "classifying" || state === "enriched"}
            />
          </>
        )}
      </div>

      {priorWriting && priorWriting.items.length > 0 ? (
        <section aria-label="What you have written about this" className="mt-6 border-border border-t pt-6">
          <h3 className="text-[13px] font-medium">What you&apos;ve written about this</h3>
          <ul className="mt-3 space-y-3">
            {priorWriting.items.map((item) => (
              <li key={item.id} className="min-w-0">
                <Link
                  href={`/alfred/notes?id=${item.id}`}
                  className="text-[13px] font-medium underline-offset-2 hover:underline"
                >
                  {item.title}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">
                  {item.basis === "from-page" ? `${priorKindLabel(item.kind)} from this page` : "Mentions this link"}
                </span>
                {item.excerpt ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.excerpt}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? (
        <p className="mt-3 text-destructive text-[13px]" role="alert">{error}</p>
      ) : null}

      {suggestions.length > 0 ? (
        <section aria-label="Suggestions" className="mt-6 flex flex-col gap-2">
          {suggestions.map((suggestion) => {
            const copy = SUGGESTION_COPY[suggestion.kind];
            if (!copy) return null;
            const confidence = confidenceLabel(suggestion.confidence);
            return (
              <div key={suggestion.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <Sparkles aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="text-[13px] font-medium">{copy.label}</span>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {[suggestion.rationale, confidence].filter(Boolean).join(" · ")}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {suggestion.kind === "contact" ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/command-center/relationships/contacts">Add contact</Link>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => decideSuggestion(suggestion, "accept")}>
                      {copy.accept}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => decideSuggestion(suggestion, "reject")}>
                    Dismiss
                  </Button>
                </span>
              </div>
            );
          })}
        </section>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-2 border-border border-t pt-4">
        {state === "open" || state === "unprocessed" || state === "classifying" || state === "enriched" || state === "failed" ? (
          <>
            {capture.kind === "file" || voiceWithoutTranscript ? null : (
              <Button size="sm" disabled={pending} onClick={saveAsNote}>
                Save as note
              </Button>
            )}
            {capture.kind === "file" || voiceWithoutTranscript || !(capture.cleanText ?? capture.text)?.trim() ? null : (
              <Button size="sm" variant="outline" disabled={pending} onClick={saveAsDocument} title="File the text as a library document; zettel proposals follow">
                Save to library
              </Button>
            )}
            {voiceWithoutTranscript ? null : (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act("converted")}>
                Make task
              </Button>
            )}
            {capture.kind === "file" ? (
              <span className="flex items-center text-xs text-muted-foreground">
                A file stays a file - notes and drafts start from text. Make a task from its filename, or open the file itself.
              </span>
            ) : voiceWithoutTranscript ? (
              <span className="flex items-center text-xs text-muted-foreground">
                {capture.failureReason ?? "The transcript lands here once transcription runs; then it works like any text capture."}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                Turn into
                {DRAFT_TEMPLATES.map((template) => (
                  <Button key={template} size="sm" variant="ghost" disabled={pending} onClick={() => saveAsDraft(template)}>
                    {DRAFT_TEMPLATE_LABEL[template]}
                  </Button>
                ))}
              </span>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("discarded")}>
              Archive
            </Button>
          </>
        ) : null}
        {capture.parkedAt && state !== "discarded" && state !== "converted" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            title="Set aside at the end of the day; unparking puts it back in the queue"
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await unparkCaptureAction({ captureId: capture.id, expectedVersion: capture.version });
                if (!result.ok) setError(result.error);
              });
            }}
          >
            Unpark
          </Button>
        ) : null}
        {state === "discarded" ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act("unprocessed")}>
            Restore capture
          </Button>
        ) : null}
        {state === "converted" && (capture.convertedType === "note" || capture.convertedType?.startsWith("draft:")) && capture.convertedId ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/alfred/notes?id=${encodeURIComponent(capture.convertedId)}`}>{capture.convertedType === "note" ? "Open note" : "Open draft"}</Link>
          </Button>
        ) : null}
        {state === "converted" && capture.convertedType === "document" && capture.convertedId ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/alfred/knowledge?doc=${encodeURIComponent(capture.convertedId)}`}>Open in Document Vault</Link>
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

type FilePayload = { filename?: string; mimeType?: string; sizeBytes?: number; quarantined?: boolean };

function formatBytes(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown size";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/*
 * A file capture's detail: the filename is the whole label. The bytes open or
 * download through the tenant-checked file route; the contents are never
 * extracted or searchable here. A quarantined file (type unrecognized) is
 * named as such and downloads rather than rendering.
 */
function FileCapturePanel({ captureId, rawPayload }: { captureId: string; rawPayload: unknown }) {
  const payload = (rawPayload ?? {}) as FilePayload;
  const filename = payload.filename?.trim() || "Captured file";
  const quarantined = payload.quarantined === true;
  return (
    <section aria-label="Captured file" className="flex flex-col gap-3">
      <p className="text-[15px] font-medium break-words text-foreground">{filename}</p>
      <p className="text-[13px] text-muted-foreground">
        {quarantined ? "Type not recognized - stored as-is" : (payload.mimeType ?? "File")} · {formatBytes(payload.sizeBytes)}
      </p>
      <p className="max-w-[70ch] text-[13px] text-muted-foreground">
        Stored as captured. The file&apos;s contents aren&apos;t searchable; the filename is the label.
        {quarantined ? " It downloads rather than opening in the browser." : ""}
      </p>
      <div>
        <a
          href={`/api/v1/captures/${captureId}/file`}
          target="_blank"
          rel="noreferrer"
          className="text-[13px] font-medium text-primary underline-offset-4 hover:underline"
        >
          {quarantined ? "Download file" : "Open file"}
        </a>
      </div>
    </section>
  );
}
