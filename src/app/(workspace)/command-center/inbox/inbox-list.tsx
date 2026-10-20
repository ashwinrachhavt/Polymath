"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace/ui";
import { setCaptureStateAction } from "./actions";

/*
 * The list pane: clamped previews over the 300-char slice, per-row and bulk
 * decisions through the version-checked actions. Rows are plain links (D12);
 * the checkbox is the only non-navigating control. Optimistic reducer (D2):
 * in "all" a decided row stays visible with its new state, elsewhere it
 * leaves the list; a conflict returns it as the transition settles.
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

function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function rowTitle(row: InboxRow): string {
  const body = row.preview?.trim() || row.url || "Empty capture";
  return body.slice(0, 80);
}

export function InboxList({ rows, view, selectedId }: { rows: InboxRow[]; view: InboxView; selectedId: string | null }) {
  const [optimisticRows, decide] = useOptimistic(rows, (current: InboxRow[], decision: Decision) =>
    view === "all"
      ? current.map((row) => (row.id === decision.id ? { ...row, processingState: decision.next } : row))
      : current.filter((row) => row.id !== decision.id),
  );
  const [bulkErrors, setBulkErrors] = useState<Array<{ id: string; title: string; message: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const bulk = selected.size > 0;
  // Converted rows cannot transition; every other selected row is sent and
  // non-permitting rows fail through the setCaptureState domain guard (D15).
  const bulkTargets = optimisticRows.filter(
    (row) => selected.has(row.id) && row.processingState !== "converted",
  );

  function bulkAct(next: "discarded" | "unprocessed") {
    const targets = bulkTargets;
    startTransition(async () => {
      const failures: Array<{ id: string; title: string; message: string }> = [];
      await Promise.all(
        targets.map(
          (row) =>
            new Promise<void>((resolve) => {
              decide({ id: row.id, next });
              setCaptureStateAction({ captureId: row.id, expectedVersion: row.version, state: next }).then((result) => {
                if (!result.ok) failures.push({ id: row.id, title: rowTitle(row), message: result.error });
                resolve();
              });
            }),
        ),
      );
      setBulkErrors(failures);
      setSelected(new Set());
    });
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="relative">
      <ul className="divide-y divide-border" role="list">
        {optimisticRows.map((capture) => {
          const isSelected = selected.has(capture.id);
          const isHighlighted = capture.id === selectedId;
          return (
            <li key={capture.id} className={isSelected ? "bg-muted" : undefined}>
              <div className="flex items-start gap-2 py-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(capture.id)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`Select capture: ${rowTitle(capture)}`}
                  className="mt-1 size-4 accent-[var(--primary)]"
                />
                <Link
                  href={`/command-center/inbox?${view === "unprocessed" ? "" : `filter=${view}&`}id=${capture.id}`}
                  className={`group block min-w-0 flex-1 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                    isHighlighted ? "bg-muted" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Status>{capture.processingState}</Status>
                    <span className="text-xs text-muted-foreground">{capture.kind}</span>
                    <time className="readout ml-auto text-xs text-muted-foreground" dateTime={capture.createdAt}>
                      {when(capture.createdAt)}
                    </time>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px]">
                    {capture.preview?.trim() || capture.url}
                  </p>
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
          className="sticky bottom-4 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-[var(--shadow)] transition-all duration-150"
        >
          <span className="readout text-[13px]">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => bulkAct("discarded")}>
            Archive
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => bulkAct("unprocessed")}>
            Restore capture
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
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
