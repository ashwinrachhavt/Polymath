"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "cn";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Unavailable } from "./ui";

export type ImportResult =
  | { kind: "file"; label: string; value: string; size: number }
  | { kind: "url"; label: string; value: string }
  | { kind: "note"; label: string; value: string };

const maxBytes = 1024 * 1024;

export function ImportDrop({ onImport, accept, hint = "Drop a file here, or paste a URL or some text. Files up to 1 MB; nothing leaves this browser.", children }: { onImport: (result: ImportResult) => void; accept?: string; hint?: string; children?: ReactNode }) {
  const [active, setActive] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function takeFile(file: File) {
    setError("");
    if (file.size > maxBytes) { setError("Choose a file no larger than 1 MB. Use the library for larger document uploads."); return; }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setReading(false);
      if (typeof reader.result !== "string") { setError("The file could not be read. Choose it again."); return; }
      const encoded = reader.result.slice(reader.result.indexOf(",") + 1);
      onImport({ kind: "file", label: file.name, value: `data:application/octet-stream;base64,${encoded}`, size: file.size });
    };
    reader.onerror = () => { setReading(false); setError("The file could not be read. Choose it again."); };
    reader.onabort = () => { setReading(false); setError("Reading was interrupted. Choose the file again."); };
    reader.readAsDataURL(file);
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
    setError("");
    const url = /^https?:\/\/\S+$/.test(value);
    let label = value.slice(0, 60);
    if (url) {
      try { label = new URL(value).hostname; }
      catch { setError("Enter a valid http or https URL, or paste plain text."); return; }
    }
    onImport({ kind: url ? "url" : "note", label, value });
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
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Paste a URL or text to import"
          className="h-9 min-w-40 flex-1 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Paste a URL or text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(text); } }}
        />
        <Button type="button" variant="outline" size="sm" disabled={!text.trim()} onClick={() => submit(text)}>Add pasted item</Button>
        <Button type="button" variant="outline" size="sm" disabled={reading} onClick={() => input.current?.click()}>{reading ? "Reading file" : "Choose a file"}</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <input ref={input} type="file" accept={accept} className="sr-only" aria-hidden tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; if (file) takeFile(file); event.target.value = ""; }} />
      {children}
    </div>
  );
}

/*
 * The state a dropped file leaves behind. It is not a claim that extraction
 * ran, so the owner sees exactly what is and is not known about the file.
 */
export function ImportedFileState({ name, size, value, onRemove }: { name: string; size?: number; value?: string; onRemove?: () => void }) {
  const download = value && /^data:application\/octet-stream;base64,[A-Za-z0-9+/=]*$/.test(value) ? value : undefined;
  let href: string | undefined;
  if (value && !download && URL.canParse(value)) {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol)) href = url.href;
  }
  return (
    <div className="panel flex items-start gap-3 rounded-lg p-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {size === undefined ? "Attached as a reference." : `${Math.max(1, Math.round(size / 1024))} KB. Held in this browser only; text extraction and classification are not connected.`}
        </p>
      </div>
      {download && <Button variant="outline" size="sm" asChild><a href={download} download={name}>Download</a></Button>}
      {href && <Button variant="outline" size="sm" asChild><a href={href} target="_blank" rel="noreferrer">Open link</a></Button>}
      {!download && !href && value && size === undefined && <p className="whitespace-pre-wrap break-words text-[13px]">{value}</p>}
      {onRemove && <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>}
    </div>
  );
}

export function ExtractionUnavailable() {
  return <Unavailable feature="Text extraction and classification">Files stay in this browser as references. Extraction, type review, classification and renaming run as durable server workflows and are not simulated here.</Unavailable>;
}
