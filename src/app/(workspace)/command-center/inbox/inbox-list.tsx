"use client";

import { cn } from "cn";
import {
  AlignLeft,
  FileText,
  Forward,
  Link2,
  Mic,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { listHref } from "@/lib/list-params";
import { setCaptureStateAction } from "./actions";

/*
 * The list pane: one clamped line of primary text, a muted metadata line, and
 * a right-aligned relative timestamp per row, with the capture kind as a
 * leading glyph. Rows are plain links (D12); the checkbox is the only
 * non-navigating control. Optimistic reducer (D2): in "all" a decided row
 * stays visible with its new state, elsewhere it leaves the list; a conflict
 * returns it as the transition settles.
 */

export type InboxRow = {
  id: string;
  processingState: string;
  kind: string;
  createdAt: string;
  preview: string | null;
  url: string | null;
  version: number;
  convertedType: string | null;
  convertedId: string | null;
};

export type InboxView = "unprocessed" | "converted" | "discarded" | "all";

type Decision = { id: string; next: "converted" | "discarded" | "unprocessed" };

const KIND_ICONS: Record<string, LucideIcon> = {
  text: AlignLeft,
  url: Link2,
  file: FileText,
  voice: Mic,
  forwarded: Forward,
};

const KIND_LABELS: Record<string, string> = {
  text: "Text",
  url: "Link",
  file: "File",
  voice: "Voice",
  forwarded: "Forwarded",
};

/* Database enums never reach the screen (ASH-127's rule, applied to captures). */
const STATE_LABELS: Record<string, string> = {
  open: "Open",
  unprocessed: "To clarify",
  classifying: "Classifying",
  enriched: "Enriched",
  failed: "Could not process",
  converted: "Converted",
  discarded: "Archived",
};

export function captureKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function captureStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** One line of primary text: the first line of the body, else the URL. */
export function captureTitle(capture: { preview?: string | null; text?: string | null; url?: string | null; rawPayload?: unknown }): string {
  const body = capture.preview ?? capture.text ?? "";
  const first = body.trim().split("\n")[0]?.trim();
  // A file capture's only label is its filename.
  const filename = ((capture.rawPayload ?? {}) as { filename?: string }).filename?.trim();
  return first || capture.url || filename || "Empty capture";
}

function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function InboxList({ rows, view, selectedId, rawQuery }: { rows: InboxRow[]; view: InboxView; selectedId: string | null; rawQuery: Record<string, string | string[] | undefined> }) {
  const [optimisticRows, decide] = useOptimistic(rows, (current: InboxRow[], decision: Decision) =>
    view === "all"
      ? current.map((row) => (row.id === decision.id ? { ...row, processingState: decision.next } : row))
      : current.filter((row) => row.id !== decision.id),
  );
  const [bulkErrors, setBulkErrors] = useState<Array<{ id: string; title: string; message: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const lastToggledId = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const bulk = selected.size > 0;
  // Converted rows cannot transition; every other selected row is sent and
  // non-permitting rows fail through the setCaptureState domain guard (D15).
  const bulkTargets = optimisticRows.filter(
    (row) => selected.has(row.id) && row.processingState !== "converted",
  );

  function bulkAct(next: "discarded" | "unprocessed") {
    // Focus origin is tracked explicitly: on click the toolbar button (not
    // the row) holds focus, so activeElement cannot identify the row.
    const originId = lastToggledId.current;
    const targets = bulkTargets;
    startTransition(async () => {
      const failures: Array<{ id: string; title: string; message: string }> = [];
      setBulkErrors([]);
      await Promise.all(
        targets.map(
          (row) =>
            new Promise<void>((resolve) => {
              decide({ id: row.id, next });
              setCaptureStateAction({ captureId: row.id, expectedVersion: row.version, state: next }).then(
                (result) => {
                  if (!result.ok) failures.push({ id: row.id, title: captureTitle(row), message: result.error });
                  resolve();
                },
                () => {
                  // A transport rejection must settle too, or Promise.all
                  // hangs and the toolbar stays pending forever.
                  failures.push({ id: row.id, title: captureTitle(row), message: "The inbox write failed." });
                  resolve();
                },
              );
            }),
        ),
      );
      setBulkErrors(failures);
      // Keep the selection (and the toolbar that renders the errors) when any
      // row failed: clearing both in one batch unmounts the error list before
      // it is ever seen.
      if (!failures.length) {
        setSelected(new Set());
        // Focus returns to the originating row link when the selection clears
        // (D12); only when that row still exists after the transition.
        const row = originId ? listRef.current?.querySelector<HTMLAnchorElement>(`li[data-capture-id="${originId}"] a`) : null;
        row?.focus();
      }
    });
  }

  function toggle(id: string) {
    lastToggledId.current = id;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="relative pb-2">
      <ul ref={listRef} className="py-1" role="list">
        {optimisticRows.map((capture) => {
          const isChecked = selected.has(capture.id);
          const isHighlighted = capture.id === selectedId;
          const Icon = KIND_ICONS[capture.kind] ?? FileText;
          const title = captureTitle(capture);
          return (
            <li
              key={capture.id}
              data-capture-id={capture.id}
              className={cn(
                "group/row border-l-2 transition-colors duration-150",
                isHighlighted ? "border-primary bg-muted/60" : "border-transparent hover:bg-muted/40",
                isChecked && "bg-muted/40",
              )}
            >
              <div className="flex min-h-14 items-center gap-2 pr-4 pl-2">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(capture.id)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`Select capture: ${title}`}
                  className="size-3.5 shrink-0 cursor-pointer accent-[var(--primary)] opacity-0 transition-opacity duration-150 checked:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 max-sm:size-4 max-sm:opacity-100"
                />
                <span
                  aria-hidden
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-muted-foreground",
                    isHighlighted ? "border-border bg-background" : "border-border/70 bg-card",
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                <Link
                  href={listHref("/command-center/inbox", rawQuery, { id: capture.id })}
                  aria-current={isHighlighted ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-5">{title}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">{captureKindLabel(capture.kind)}</span>
                      {capture.processingState !== "unprocessed" ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="truncate">{captureStateLabel(capture.processingState)}</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <time
                    suppressHydrationWarning
                    dateTime={capture.createdAt}
                    className="readout shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {when(capture.createdAt)}
                  </time>
                </Link>
              </div>
            </li>
          );
        })}
      </ul>

      {bulk ? (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          aria-live="polite"
          className="sticky bottom-3 mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-[var(--shadow)] transition-all duration-150 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:z-30 max-sm:min-h-[44px]"
        >
          <span className="readout pl-1 text-[13px]">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => bulkAct("discarded")}>
              Archive
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => bulkAct("unprocessed")}>
              Restore capture
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setSelected(new Set()); setBulkErrors([]); }}>
              Clear
            </Button>
          </div>
          {bulkErrors.length ? (
            <ul className="w-full text-[13px]">
              {bulkErrors.map((failure) => (
                <li key={failure.id} className="text-destructive" role="alert">
                  {failure.title}: {failure.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
