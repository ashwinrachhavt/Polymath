"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "cn";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Unavailable } from "./ui";

/*
 * Intake for a file, a URL or pasted text. The preview has no server, so the
 * honest contract is: the file is read locally for its name and size, and its
 * contents are never uploaded or claimed as extracted. A URL is attached as a
 * link the owner can open. Pasted text is a capture.
 */

export type ImportResult =
  | { kind: "file"; label: string; value: string; size: number }
  | { kind: "url"; label: string; value: string }
  | { kind: "note"; label: string; value: string };

const maxBytes = 1024 * 1024;

export function ImportDrop({ onImport, accept, hint = "Drop a file here, or paste a URL or some text. Files up to 1 MB; nothing leaves this browser.", children }: { onImport: (result: ImportResult) => void; accept?: string; hint?: string; children?: ReactNode }) {
  const [active, setActive] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function takeFile(file: File) {
    if (file.size > maxBytes) { onImport({ kind: "file", label: `${file.name} is too large`, value: "" , size: file.size }); return; }
    onImport({ kind: "file", label: file.name, value: URL.createObjectURL(file), size: file.size });
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    setActive(false);
    const file = event.dataTransfer.files[0];
    if (file) { takeFile(file); return; }
    const dropped = event.dataTransfer.getData("text/plain").trim();
    if (dropped) submit(dropped);
  }
  function submit(raw: string) {
    const value = raw.trim();
    if (!value) return;
    const url = /^https?:\/\/\S+$/.test(value);
    onImport({ kind: url ? "url" : "note", label: url ? new URL(value).hostname : value.slice(0, 60), value });
    setText("");
  }

  return (
    <div
      className={cn("panel-empty flex flex-col gap-3 rounded-lg p-4 transition-colors", active && "border-ring bg-muted/40")}
      onDragOver={(event) => { event.preventDefault(); setActive(true); }}
      onDragLeave={() => setActive(false)}
      onDrop={onDrop}
    >
      <div className="flex items-start gap-3">
        <Upload aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="font-medium">Add material</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">{hint}</p>
        </div>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); submit(text); }}>
        <input
          aria-label="Paste a URL or text to import"
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Paste a URL or text"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!text.trim()}>Add pasted item</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>Choose a file</Button>
      </form>
      <input ref={input} type="file" accept={accept} className="sr-only" aria-hidden tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; if (file) takeFile(file); event.target.value = ""; }} />
      {children}
    </div>
  );
}

/*
 * The state a dropped file leaves behind. It is not a claim that extraction
 * ran, so the owner sees exactly what is and is not known about the file.
 */
export function ImportedFileState({ name, size, onRemove }: { name: string; size?: number; onRemove?: () => void }) {
  return (
    <div className="panel flex items-start gap-3 rounded-lg p-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {size === undefined ? "Attached as a reference." : `${Math.max(1, Math.round(size / 1024))} KB. Held in this browser only; text extraction and classification are not connected.`}
        </p>
      </div>
      {onRemove && <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>}
    </div>
  );
}

export function ExtractionUnavailable() {
  return <Unavailable feature="Text extraction and classification">Files stay in this browser as references. Extraction, type review, classification and renaming run as durable server workflows and are not simulated here.</Unavailable>;
}
