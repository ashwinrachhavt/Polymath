"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, FileText, FileUp, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { requestJson, type RequestFailure } from "@/lib/client-request";

/*
 * The one upload affordance: drop one or many files, watch each store, then
 * watch each read. Two waits per file, never conflated: bytes leaving the
 * browser (real XHR progress), then the extraction worker, which reports no
 * percentage - its ring is indeterminate on purpose and ends at a terminal
 * status from the server. Each file uploads on its own, so one failure never
 * blocks the others.
 *
 * Polling stops the moment a file is terminal, and every upload aborts when
 * the panel unmounts, so an idle tab never keeps asking.
 */

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

export type FilePhase =
  | { kind: "uploading"; percent: number }
  | { kind: "reading" }
  | { kind: "done"; documentId: string }
  | { kind: "error"; message: string };

type Entry = { id: string; file: File; phase: FilePhase };

// A poll can outlast a session. These kinds say the request will keep failing
// for the same reason, so waiting out the full ceiling would turn a clear cause
// into three minutes of silence and the wrong diagnosis at the end.
export const TERMINAL_POLL_KINDS = new Set<RequestFailure["kind"]>(["unauthenticated", "forbidden", "not_found"]);

// A throttle is transient, so it stays retryable. Counting consecutive 429s
// bounds a server that keeps refusing at ~30s instead of 120 attempts. The
// counter resets on any successful poll, so a slow extraction that trips one
// throttle occasionally is never mistaken for a sustained block.
export const RATE_LIMIT_CEILING = 20;

// A server or connection that never recovers should be named, not guessed at.
// Counting consecutive failures of these kinds bounds an outage in ~30s rather
// than 120 attempts and three minutes, after which the exhaustion copy blamed
// the queue worker for a fault that was never about the queue.
export const TRANSIENT_FAILURE_CEILING = 20;

// Kinds that mean "the server or the connection is not answering right now".
// They stay retryable - a single blip is not a verdict - but a sustained run of
// them is, and the person needs the real cause rather than the worker guess.
const TRANSIENT_FAILURE_KINDS = new Set<RequestFailure["kind"]>(["server", "network", "timeout"]);

export type PollDecision =
  | { action: "stop"; message: string }
  | { action: "continue"; countsToward: "rate_limit" | "transient" | null };

/** Classify a failed poll: stop with the cause, retry, or retry and count it. */
export function shouldStopPolling(failure: RequestFailure): PollDecision {
  if (TERMINAL_POLL_KINDS.has(failure.kind)) return { action: "stop", message: failure.title };
  // A cancellation is not a blip: retrying a request the caller aborted would
  // repeat work nobody asked for. The loop passes no signal today, so this
  // guards the behaviour before one arrives.
  if (failure.kind === "aborted") return { action: "stop", message: failure.title };
  if (failure.kind === "rate_limited") return { action: "continue", countsToward: "rate_limit" };
  if (TRANSIENT_FAILURE_KINDS.has(failure.kind)) return { action: "continue", countsToward: "transient" };
  // An unknown future kind retries uncounted: a blip costs one more poll, while
  // stopping on a healthy poll would abandon a document that was about to finish.
  return { action: "continue", countsToward: null };
}

export type PollStep =
  | { action: "stop"; message: string }
  | { action: "continue"; rateLimitStreak: number; transientStreak: number };

/**
 * One poll's effect on the loop. A terminal cause stops. A success clears both
 * streaks, because the server just proved it is answering. A count of one kind
 * clears the other's streak: alternating throttles and 5xxs must not add up to
 * a stop neither cause alone would produce.
 */
export function advancePoll(
  outcome: { ok: true } | { ok: false; failure: RequestFailure },
  rateLimitStreak: number,
  transientStreak = 0,
): PollStep {
  if (outcome.ok) return { action: "continue", rateLimitStreak: 0, transientStreak: 0 };
  const decision = shouldStopPolling(outcome.failure);
  if (decision.action === "stop") return decision;
  if (decision.countsToward === "rate_limit") {
    const streak = rateLimitStreak + 1;
    if (streak >= RATE_LIMIT_CEILING) return { action: "stop", message: outcome.failure.title };
    return { action: "continue", rateLimitStreak: streak, transientStreak: 0 };
  }
  if (decision.countsToward === "transient") {
    const streak = transientStreak + 1;
    if (streak >= TRANSIENT_FAILURE_CEILING) return { action: "stop", message: outcome.failure.title };
    return { action: "continue", rateLimitStreak: 0, transientStreak: streak };
  }
  return { action: "continue", rateLimitStreak: 0, transientStreak: 0 };
}

function Ring({ percent, indeterminate, done }: { percent: number; indeterminate?: boolean; done?: boolean }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  return (
    <svg viewBox="0 0 48 48" className="size-10 shrink-0" aria-hidden>
      <circle cx="24" cy="24" r={radius} fill="none" strokeWidth="4" className="stroke-muted" />
      <circle
        cx="24"
        cy="24"
        r={radius}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={indeterminate ? circumference * 0.75 : offset}
        className={`${done ? "stroke-emerald-500" : "stroke-primary"} ${indeterminate ? "origin-center animate-spin" : "transition-[stroke-dashoffset] duration-300"} -rotate-90`}
      />
    </svg>
  );
}

function PhaseIcon({ phase }: { phase: FilePhase }) {
  if (phase.kind === "reading") return <Loader2 aria-hidden className="text-muted-foreground size-4 animate-spin" />;
  if (phase.kind === "done") return <Check aria-hidden className="size-4 text-emerald-500" />;
  return null;
}

/** The row's metadata line: what the phase is doing, or why it failed. */
export function phaseLabel(phase: FilePhase): string {
  switch (phase.kind) {
    case "uploading":
      return `Uploading ${phase.percent}%`;
    case "reading":
      return "Reading the text…";
    case "done":
      return "Read";
    case "error":
      // The badge already says "Failed"; this line carries the cause, which is
      // the only part the person can act on.
      return phase.message;
  }
}

/*
 * The badge is text a screen reader would reach only by leaving the live
 * region, and the cause is the actionable half; announce it with the counts.
 */
export function failureCopy(entries: { phase: FilePhase }[]): string {
  const failure = entries.find((entry) => entry.phase.kind === "error")?.phase;
  return failure?.kind === "error" ? `, failed: ${failure.message}` : "";
}

export function UploadDropzone({ libraryHref = "/alfred/library" }: { libraryHref?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [openText, setOpenText] = useState<string | null>(null); // documentId of the expanded entry
  const [openBody, setOpenBody] = useState<string | null>(null); // extracted text once loaded
  const [openError, setOpenError] = useState<string | null>(null); // preview failure copy
  const [openPending, setOpenPending] = useState(false);
  const liveId = useId();

  useEffect(() => {
    const map = xhrs.current;
    return () => {
      for (const xhr of map.values()) xhr.abort();
    };
  }, []);

  const patch = useCallback((id: string, phase: FilePhase) => {
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, phase } : entry)));
  }, []);

  // The reading ring is honest only if it ends: poll the document until a
  // terminal status, then stop. A long silence is reported, not spun forever.
  const poll = useCallback(async (id: string, documentId: string) => {
    let throttleStreak = 0;
    let transientStreak = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const result = await requestJson<{ extractionStatus?: string | null; extractionError?: string | null }>(
        `/api/v1/files?documentId=${encodeURIComponent(documentId)}`,
      );
      // A network blip is not a verdict; a 401/403/404 is, and the person
      // needs the cause now rather than a queue-worker guess in three minutes.
      // A sustained run of 5xx/network/timeout stops the same way and shows
      // that cause instead of the worker guess.
      const step = advancePoll(result, throttleStreak, transientStreak);
      if (step.action === "stop") {
        patch(id, { kind: "error", message: step.message });
        return;
      }
      throttleStreak = step.rateLimitStreak;
      transientStreak = step.transientStreak;
      if (!result.ok) continue;
      const body = result.data;
      if (body.extractionStatus === "succeeded") {
        patch(id, { kind: "done", documentId });
        router.refresh();
        return;
      }
      if (body.extractionStatus === "failed") {
        patch(id, { kind: "error", message: body.extractionError ?? "The document could not be read." });
        return;
      }
    }
    patch(id, {
      kind: "error",
      message: "Stored, but reading has not started. Is the queue worker running? (make queue-up)",
    });
  }, [patch, router]);

  const upload = useCallback((entry: Entry) => {
    const body = new FormData();
    body.append("file", entry.file);
    body.append("title", entry.file.name.replace(/\.[^.]+$/, "") || entry.file.name);

    const xhr = new XMLHttpRequest();
    xhrs.current.set(entry.id, xhr);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      patch(entry.id, { kind: "uploading", percent: Math.round((event.loaded / event.total) * 100) });
    };
    xhr.onload = () => {
      xhrs.current.delete(entry.id);
      type UploadResponse = { documentId?: string; fileStatus?: string; title?: string };
      let payload: UploadResponse | null = null;
      try {
        payload = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (payload?.fileStatus === "quarantined") {
          patch(entry.id, { kind: "error", message: "Kept, but its type could not be identified, so no document was created." });
          return;
        }
        if (payload?.documentId) {
          patch(entry.id, { kind: "reading" });
          void poll(entry.id, payload.documentId);
          return;
        }
      }
      patch(entry.id, { kind: "error", message: payload?.title ?? `Upload failed (${xhr.status}).` });
    };
    xhr.onerror = () => {
      xhrs.current.delete(entry.id);
      patch(entry.id, { kind: "error", message: "Network error." });
    };
    xhr.open("POST", "/api/v1/files");
    xhr.setRequestHeader("Idempotency-Key", crypto.randomUUID());
    xhr.send(body);
  }, [patch, poll]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const next = Array.from(files)
      .filter((file) => file.size > 0)
      .map((file) => ({ id: crypto.randomUUID(), file, phase: { kind: "uploading", percent: 0 } as FilePhase }));
    if (!next.length) return;
    setEntries((current) => [...current, ...next]);
    for (const entry of next) upload(entry);
  }, [upload]);

  const dismiss = (id: string) => {
    xhrs.current.get(id)?.abort();
    xhrs.current.delete(id);
    setEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const toggleText = async (documentId: string) => {
    if (openText === documentId) {
      setOpenText(null);
      setOpenBody(null);
      setOpenError(null);
      return;
    }
    setOpenText(documentId);
    setOpenPending(true);
    setOpenBody(null);
    setOpenError(null);
    const detail = await requestJson<{ excerpt?: string | null }>(`/api/v1/documents/${documentId}/preview`);
    // The preview route returns an excerpt by design; the full text lives in
    // the library's reader. Link there rather than shipping the body twice.
    // An empty panel on failure would read as "no text", so the panel carries
    // the failure's own copy instead; a cancelled request just closes quietly.
    if (detail.ok) setOpenBody(detail.data.excerpt ?? "");
    else if (detail.failure.kind !== "aborted") setOpenError(detail.failure.title);
    setOpenPending(false);
  };

  const busy = entries.some((entry) => entry.phase.kind === "uploading" || entry.phase.kind === "reading");
  const anyDone = entries.some((entry) => entry.phase.kind === "done");
  const failureAnnouncement = failureCopy(entries);

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite" id={liveId} className="sr-only">
        {`${entries.filter((entry) => entry.phase.kind === "uploading").length} uploading, ${entries.filter((entry) => entry.phase.kind === "reading").length} reading, ${entries.filter((entry) => entry.phase.kind === "done").length} done${failureAnnouncement}`}
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy && event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border"
        }`}
      >
        <span className="flex size-10 items-center justify-center rounded-full border border-border">
          <FileUp aria-hidden className="text-muted-foreground size-4" />
        </span>
        <div>
          <p className="text-[13px] font-medium">Choose files or drag &amp; drop them here</p>
          <p className="text-muted-foreground mt-1 text-xs">PDF, PNG and JPEG, up to 25 MB each. Stored as originals, then read.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} aria-describedby={liveId} disabled={busy}>
          {busy ? "Working…" : "Browse files"}
        </Button>
      </div>

      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const documentId = entry.phase.kind === "done" ? entry.phase.documentId : null;
            const expanded = documentId !== null && openText === documentId;
            return (
              <li key={entry.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                <div className="relative flex items-center justify-center">
                  <Ring
                    percent={entry.phase.kind === "uploading" ? entry.phase.percent : 100}
                    indeterminate={entry.phase.kind === "reading"}
                    done={entry.phase.kind === "done"}
                  />
                  <span className="absolute"><PhaseIcon phase={entry.phase} /></span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{entry.file.name}</p>
                  {/* Recovery copy can be a full sentence; two clamped lines keeps
                      the row height stable while the title attribute keeps it whole. */}
                  <p
                    className={`text-muted-foreground text-xs ${entry.phase.kind === "error" ? "line-clamp-2" : "truncate"}`}
                    title={entry.phase.kind === "error" ? entry.phase.message : undefined}
                  >
                    {phaseLabel(entry.phase)}
                  </p>
                </div>
                {entry.phase.kind === "done" ? (
                  <Badge variant="outline">Read</Badge>
                ) : entry.phase.kind === "error" ? (
                  <Badge variant="outline" className="border-destructive/40 text-destructive">Failed</Badge>
                ) : null}
                {documentId ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void toggleText(documentId)}>
                    {expanded ? "Hide text" : "View text"}
                  </Button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Dismiss ${entry.file.name}`}
                  className="text-muted-foreground hover:text-foreground rounded p-1"
                  onClick={() => dismiss(entry.id)}
                >
                  <X aria-hidden className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {openText ? (
        <section className="rounded-lg border border-border p-4">
          <div className="mb-3 flex items-center gap-2">
            <FileText aria-hidden className="text-muted-foreground size-4" />
            <h3 className="text-[13px] font-medium">Extracted text</h3>
            <Badge variant="outline" className="ml-auto">Extracted by Polymath</Badge>
          </div>
          {openPending ? (
            <p role="status" className="text-muted-foreground text-xs">Loading the extracted text…</p>
          ) : openError ? (
            <p role="alert" className="text-[13px] text-destructive">{openError}</p>
          ) : openBody ? (
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-[13px] leading-relaxed">
              {openBody}
              <p className="text-muted-foreground mt-2 text-xs">First 1,200 characters. The full text is in the library reader.</p>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No readable text was extracted from this document.</p>
          )}
          <div className="mt-3">
            <Link href={libraryHref} className="text-primary text-xs underline underline-offset-4">
              Open the library
            </Link>
          </div>
        </section>
      ) : null}

      {anyDone ? (
        <Link href={libraryHref} className="text-primary w-fit text-xs underline underline-offset-4">
          Open the library to keep reading
        </Link>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        aria-label="Choose documents to upload"
        className="sr-only"
        onChange={(event) => {
          if (event.target.files?.length) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
