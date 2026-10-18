"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * The inbox's one affordance: a file becomes a document. The UUID
 * Idempotency-Key is generated per attempt so a retry of a network failure
 * re-uploads (a new attempt is a new intent), while a double-click of the same
 * attempt replays the first response instead of duplicating the document.
 */

type UploadState = { kind: "idle" } | { kind: "busy" } | { kind: "message"; text: string; error: boolean };

export function UploadButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const liveId = useId();

  async function upload(file: File) {
    setState({ kind: "busy" });
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
        | { fileStatus?: string }
        | { title?: string }
        | null;

      if (response.ok) {
        if (payload && "fileStatus" in payload && payload.fileStatus === "quarantined") {
          setState({
            kind: "message",
            text: "We kept the file but couldn't identify its type, so no document was created.",
            error: true,
          });
        } else {
          setState({ kind: "message", text: `${file.name} added to the inbox.`, error: false });
          router.refresh();
        }
      } else {
        const problem = payload && "title" in payload ? payload.title : null;
        setState({
          kind: "message",
          text: problem ?? `${file.name} could not be uploaded (${response.status}).`,
          error: true,
        });
      }
    } catch {
      setState({ kind: "message", text: `${file.name} could not be uploaded — network error.`, error: true });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div aria-live="polite" id={liveId} className="sr-only">
        {state.kind === "busy" ? "Uploading" : state.kind === "message" ? state.text : ""}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.png,.jpeg,.jpg"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={state.kind === "busy"}
        aria-describedby={liveId}
        className="w-fit"
      >
        {state.kind === "busy" ? "Uploading…" : "Upload a document"}
      </Button>
      {state.kind === "message" ? (
        <p role={state.error ? "alert" : "status"} className={state.error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
          {state.text}
        </p>
      ) : null}
    </div>
  );
}
