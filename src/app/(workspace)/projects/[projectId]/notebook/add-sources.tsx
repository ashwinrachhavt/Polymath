"use client";

import { useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addUrlToNotebookAction, attachToNotebookAction } from "./add-source-actions";

/*
 * The Sources pane's capture affordance (NotebookLM pattern, IA plan 3a/8).
 * Three controls, one row each, matching the empty state's wording: a pasted
 * link (web or YouTube), a file upload, and a pick from the Document Vault.
 *
 * The pane never infers a state: a capture that lands reports through the
 * source's readiness field, and this control only reports what its own action
 * returned. A file uploads straight to POST /api/v1/files (the 4.5 MB
 * multipart ceiling is Vercel's) and the returned document id attaches here.
 */

type VaultDoc = { id: string; title: string };

export function AddSources({ projectId, vault }: { projectId: string; vault: VaultDoc[] }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const [addingUrl, setAddingUrl] = useState(false);
  const [addingVault, setAddingVault] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>) {
    setMessage(null);
    setError(null);
    await work();
  }

  function addUrl() {
    if (!url.trim()) return;
    void run(async () => {
      setAddingUrl(true);
      try {
        const out = await addUrlToNotebookAction({ projectId, url });
        if (out.ok) setUrl("");
        if (out.ok) setMessage(out.message);
        else setError(out.message);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The source could not be added.");
      } finally {
        setAddingUrl(false);
      }
    });
  }

  function upload(file: File) {
    void run(async () => {
      setUploading(file.name);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("title", file.name.replace(/\.[^.]+$/, "") || file.name);
        const response = await fetch("/api/v1/files", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body,
        });
        const payload = (await response.json().catch(() => null)) as
          | { documentId?: string; fileStatus?: string; title?: string }
          | null;
        // Quarantine must be checked before the documentId test: a quarantined
        // file answers 200 with a fileId and no documentId, so the generic
        // upload-failed branch would otherwise swallow the specific reason.
        if (!response.ok || !payload) {
          const problem = payload && "title" in payload ? payload.title : null;
          setError(problem ?? `${file.name} could not be uploaded (${response.status}).`);
          return;
        }
        if (payload.fileStatus === "quarantined") {
          setError(`We kept ${file.name} but could not identify its type, so it is not in the notebook.`);
          return;
        }
        if (!payload.documentId) {
          setError(`${file.name} could not be uploaded (${response.status}).`);
          return;
        }
        const out = await attachToNotebookAction({ projectId, documentIds: [payload.documentId] });
        if (out.ok) setMessage(out.message);
        else setError(out.message);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `${file.name} could not be uploaded.`);
      } finally {
        setUploading(null);
      }
    });
  }

  function addPicked() {
    if (!picked) return;
    void run(async () => {
      setAddingVault(true);
      try {
        const out = await attachToNotebookAction({ projectId, documentIds: [picked] });
        if (out.ok) setPicked("");
        if (out.ok) setMessage(out.message);
        else setError(out.message);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The source could not be added.");
      } finally {
        setAddingVault(false);
      }
    });
  }

  return (
    <div className="mt-2 flex flex-col gap-2 px-1">
      {/* One control per row, in the order the empty state names them. */}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          addUrl();
        }}
      >
        <Input
          aria-label="Add a URL or YouTube link"
          className="h-8 min-w-0 flex-1 text-[13px]"
          placeholder="https:// or a YouTube link"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={addingUrl || !url.trim()} aria-label="Add the link">
          {addingUrl ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
        </Button>
      </form>

      <input
        ref={fileInput}
        type="file"
        aria-label="Upload a file"
        accept=".pdf,.png,.jpeg,.jpg"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) upload(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full justify-start"
        onClick={() => fileInput.current?.click()}
        disabled={uploading !== null}
      >
        {uploading ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
        {uploading ? `Uploading ${uploading}` : "Upload a file"}
      </Button>

      {vault.length > 0 && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            addPicked();
          }}
        >
          <select
            aria-label="Pick a document from the Vault"
            className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-[13px]"
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
          >
            <option value="">Pick from the Vault</option>
            {vault.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.title}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={addingVault || !picked} aria-label="Add the picked document">
            {addingVault ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
          </Button>
        </form>
      )}

      {message && (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
