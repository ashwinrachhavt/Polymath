"use client";

import { useRef, useState, useTransition, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ImportSummary } from "@/domains/identity/party-csv";
import { importConnectionsCsv } from "./actions";

/*
 * The one import affordance for the LinkedIn connections CSV. The file is
 * read in the browser and posted as text to the server action, which hands
 * it to the identity domain's importConnections. The input resets after a
 * run so picking the same file twice actually re-imports it — a no-op
 * re-pick looks like a broken button otherwise.
 */

const MAX_BYTES = 5_000_000;

export function ImportDialog({ children }: { children: React.ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(file: File) {
    setError(null);
    setSummary(null);
    if (file.size > MAX_BYTES) {
      setError("That file is over the 5 MB import limit. Split the export or trim rows and try again.");
      return;
    }
    setFileName(file.name);
    startTransition(async () => {
      const csv = await file.text();
      const result = await importConnectionsCsv({ csv });
      if (result.ok) setSummary(result.summary);
      else setError(result.error);
    });
  }

  function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) run(file);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) run(file);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSummary(null);
          setError(null);
          setFileName(null);
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import connections</DialogTitle>
          <DialogDescription>
            Upload the CSV file LinkedIn emails you from Settings &gt; Get a copy of your data. Emails become the
            identity key: a re-run adds nothing new.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center transition-colors ${
            dragging ? "border-ring bg-accent" : "border-border bg-muted/30"
          }`}
        >
          <FileUp aria-hidden className="text-muted-foreground size-6" />
          <p className="text-[13px] font-medium">Drag the CSV here</p>
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            First name, last name, email address, company and position are read. Nothing is deleted by an import.
          </p>
          <Button type="button" variant="outline" disabled={pending} onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onChange}
            className="sr-only"
            aria-label="Import LinkedIn connections CSV"
          />
        </div>

        {fileName && pending ? (
          <p className="text-muted-foreground text-[13px]" role="status">
            Reading {fileName}…
          </p>
        ) : null}

        {summary ? (
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4" role="status">
            <p className="text-[13px] font-medium">
              Read {summary.rowsRead} row{summary.rowsRead === 1 ? "" : "s"} from {fileName}
            </p>
            <ul className="text-muted-foreground space-y-1 text-[13px]">
              <li>{summary.peopleCreated} people added</li>
              <li>{summary.peopleMatched} already known</li>
              <li>{summary.organizationsCreated} organizations added</li>
              {summary.skipped ? <li>{summary.skipped} skipped</li> : null}
            </ul>
            {summary.problems.length ? (
              <ul className="text-muted-foreground space-y-1 border-t border-border pt-2 text-xs">
                {summary.problems.slice(0, 5).map((problem) => (
                  <li key={problem.line}>
                    Line {problem.line}: {problem.reason}
                  </li>
                ))}
                {summary.problems.length > 5 ? (
                  <li>{summary.problems.length - 5} more skipped rows not shown.</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="text-destructive text-[13px]" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
