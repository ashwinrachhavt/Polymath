"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Download, LoaderCircle } from "lucide-react";

/*
 * The statement strip in the vault viewer. Uploading a bank statement now
 * detects and reads it on its own; this strip is where that work becomes
 * visible: the account and period it found, the row count, and the export.
 *
 * The honesty contract is the same as the workbench's: only a ledger whose
 * rows carry the running balance forward offers the CSV. A statement whose
 * rows do not add up says so and points at the review workbench, because a
 * ledger that is almost right is a ledger you cannot check.
 */

export type StatementStripData = {
  extraction: "none" | "pending" | "failed" | "succeeded" | "skipped";
  looksLikeStatement: boolean;
  import: {
    status: "parsed" | "needs_review" | "unsupported";
    reconciled: boolean;
    accountLabel: string;
    periodStart: string | null;
    periodEnd: string | null;
    transactionCount: number;
    error: string | null;
  } | null;
};

/** Pure view: the status decides what the strip says. Exported for render tests. */
export function StatementStripView({
  documentId,
  status,
  reading,
  onRead,
  error,
}: {
  documentId: string;
  status: StatementStripData;
  reading: boolean;
  onRead: () => void;
  error: string | null;
}) {
  const statement = status.import;

  // A document that never looked like a statement gets no strip at all. One
  // that did, but yielded no transaction table, says so - the import is only
  // ever recorded for documents the detector believed in, so silence here
  // would read as a lost click.
  if (!statement && !status.looksLikeStatement) return null;

  const period =
    statement?.periodStart && statement?.periodEnd
      ? `${statement.periodStart} to ${statement.periodEnd}`
      : (statement?.periodStart ?? null);

  return (
    <section aria-label="Bank statement" className="border-border m-4 mb-0 rounded-md border px-3.5 py-3">
      {statement?.status === "parsed" && statement.reconciled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Bank statement</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {statement.accountLabel}
              {period ? ` · ${period}` : ""} · {statement.transactionCount} transactions
            </p>
          </div>
          <a
            href={`/api/v1/documents/${documentId}/statement`}
            download
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors active:scale-[0.98]"
          >
            <Download className="size-3.5" aria-hidden />
            Export transactions to CSV
          </a>
        </div>
      ) : statement?.status === "needs_review" || (statement?.status === "parsed" && !statement.reconciled) ? (
        <div>
          <p className="text-[13px] font-medium">Bank statement</p>
          <p role="alert" className="text-muted-foreground mt-0.5 text-xs">
            {statement.error ?? "The rows read from this statement do not add up against its running balance."}{" "}
            The export stays closed until they do.{" "}
          </p>
          <p className="mt-1.5 text-xs">
            <Link
              href={`/polymath/knowledge?doc=${documentId}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              Review the ledger
            </Link>
          </p>
        </div>
      ) : statement?.status === "unsupported" ? (
        <div>
          <p className="text-[13px] font-medium">Bank statement</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {statement.error ?? "No transaction table could be read from this document."}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">This looks like a bank statement.</p>
          <button
            type="button"
            onClick={onRead}
            disabled={reading}
            className="border-input hover:bg-muted inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors active:scale-[0.98] disabled:opacity-60"
          >
            <LoaderCircle className={reading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
            {reading ? "Reading transactions…" : "Read transactions"}
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function StatementStrip({ documentId }: { documentId: string }) {
  const [status, setStatus] = useState<StatementStripData | null>(null);
  const [started, setStarted] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/statement?status=1`);
      if (!response.ok) return;
      setStatus((await response.json()) as StatementStripData);
    } catch {
      // The strip is additive: a failed status read leaves the viewer usable.
    }
  }, [documentId]);

  // Fire the first status read from render, the same pattern the viewer uses
  // for the extracted text; every later transition is event-driven.
  if (!started) {
    setStarted(true);
    void load();
  }

  const read = useCallback(() => {
    setReading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/documents/${documentId}/statement`, { method: "POST" });
        const payload = (await response.json().catch(() => null)) as (StatementStripData & { error?: string }) | null;
        if (!response.ok) {
          setError(payload?.error ?? `Reading the statement failed (${response.status}).`);
          return;
        }
        if (payload) setStatus(payload);
      } catch {
        setError("Reading the statement failed. Check the connection and try again.");
      } finally {
        setReading(false);
      }
    })();
  }, [documentId]);

  if (!status) return null;
  return <StatementStripView documentId={documentId} status={status} reading={reading} onRead={read} error={error} />;
}
