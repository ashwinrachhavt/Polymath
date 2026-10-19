"use client";

import { Select } from "@/components/ui/select";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ingestDocumentAction } from "./actions";

/*
 * Picks a read document and ingests it into the wiki. Topics are optional:
 * left blank, the summarizer names them. The message under the form is the
 * only feedback, so a failure says why.
 */

export function IngestForm({ documents }: { documents: { id: string; title: string; ingested: boolean }[] }) {
  const selectId = useId();
  const topicsId = useId();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  if (documents.length === 0) {
    return <p className="text-muted-foreground text-sm">No read documents yet. Capture or upload one in Knowledge first.</p>;
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const documentId = String(data.get("documentId") ?? "");
        const topics = String(data.get("topics") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (!documentId) return;
        startTransition(async () => {
          try {
            const result = await ingestDocumentAction(documentId, topics);
            setMessage({ text: result.message, error: !result.ok });
          } catch {
            setMessage({ text: "Ingest failed. Try again.", error: true });
          }
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="sr-only">Document to ingest</label>
        <Select id={selectId} name="documentId" required disabled={pending} className="border-input bg-background h-9 max-w-72 rounded-md border px-2 text-sm" >
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
              {d.ingested ? " (in wiki)" : ""}
            </option>
          ))}
        </Select>
        <label htmlFor={topicsId} className="sr-only">Topics, comma-separated (optional)</label>
        <input
          id={topicsId}
          name="topics"
          type="text"
          placeholder="topics, optional (e.g. job-search, axiom)"
          disabled={pending}
          className="border-input bg-background h-9 w-64 rounded-md border px-3 text-sm"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Ingesting…" : "Ingest into wiki"}
        </Button>
      </div>
      {message ? (
        <p role={message.error ? "alert" : "status"} className={message.error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
