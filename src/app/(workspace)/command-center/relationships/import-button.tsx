"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ImportSummary } from "@/domains/identity/party-csv";
import { importConnectionsCsv } from "./actions";

/*
 * LinkedIn's export is a CSV; the browser reads it and posts the text. The
 * file input resets after a run so picking the same file twice actually
 * re-imports it — a no-op re-pick looks like a broken button.
 */

export function ImportButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setSummary(null);

    startTransition(async () => {
      const csv = await file.text();
      const result = await importConnectionsCsv({ csv, fileName: file.name });
      if (result.ok) setSummary(result.summary);
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={onChange}
        className="sr-only"
        aria-label="Import LinkedIn connections CSV"
      />
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        {pending ? "Importing…" : "Import connections"}
      </Button>
      {summary ? (
        <p className="text-muted-foreground max-w-[22rem] text-right text-[12px]" role="status">
          Read {summary.rowsRead} rows: {summary.peopleCreated} people added,{" "}
          {summary.peopleMatched} already known, {summary.organizationsCreated} organizations
          added. {summary.skipped ? `${summary.skipped} rows skipped.` : null}
        </p>
      ) : null}
      {summary?.problems.length ? (
        <ul className="text-muted-foreground max-w-[22rem] text-right text-[12px]" role="status">
          {summary.problems.slice(0, 3).map((problem) => (
            <li key={problem.line}>
              Line {problem.line}: {problem.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="text-destructive max-w-[22rem] text-right text-[12px]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
