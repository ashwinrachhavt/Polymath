"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * Create a dossier: a name plus the documents it holds. The POST goes to
 * /api/v1/dossiers, which rejects any document outside the workspace; a
 * success lands in the server-rendered list on refresh.
 */
const extractionLabel: Record<string, string> = {
  succeeded: "Filed",
  pending: "Reading…",
  running: "Reading…",
  failed: "Extraction failed",
};

export function CreateDossierForm({ documents }: { documents: Array<{ id: string; title: string; extractionStatus: string | null }> }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function create() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/dossiers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, documentIds: [...selected] }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `The dossier could not be created (${response.status}).`);
      }
      setName("");
      setSelected(new Set());
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dossier could not be created.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name the dossier"
          required
          maxLength={200}
          className="border-input bg-background h-9 w-64 rounded-md border px-3 text-sm"
        />
        <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
          {pending ? "Creating…" : "New dossier"}
        </Button>
      </div>
      {documents.length > 0 ? (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border px-3 py-2">
          {documents.map((doc) => (
            <label key={doc.id} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={selected.has(doc.id)} onChange={() => toggle(doc.id)} />
              <span className="truncate">{doc.title}</span>
              <span className="text-muted-foreground text-xs">{doc.extractionStatus ? (extractionLabel[doc.extractionStatus] ?? doc.extractionStatus) : "Unread"}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[13px]">File a document in Knowledge first and it can join a dossier here.</p>
      )}
      {error ? <p className="text-destructive text-[13px]">{error}</p> : null}
    </form>
  );
}
