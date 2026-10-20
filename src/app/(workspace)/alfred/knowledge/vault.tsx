"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  FileImage,
  FileText,
  FolderOpen,
  Globe,
  LoaderCircle,
  Plus,
  RotateCw,
  Search,
  FolderUp,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Readout } from "@/components/readout";

/*
 * The document vault, on the Box pattern: a column-header table (Name,
 * Modified, Size), a quiet New + control, and a details pane when a row is
 * selected. The whole surface is a dropzone — dropped folders keep their
 * structure, and reading starts on its own. A selected row opens the split
 * viewer: the document on the left, the extracted text on the right.
 *
 * Motion answers actions only: the + rotate, the menu, the viewer slide.
 * Nothing loops, nothing decorates.
 */

export type VaultFolder = { id: string; parentId: string | null; name: string; documentCount: number };

export type VaultDocument = {
  id: string;
  title: string;
  filename: string | null;
  mimeType: string | null;
  kind: "web_page" | "file";
  status: { label: string; tone: "neutral" | "progress" | "attention" | "done" | "error" };
  sourceUrl: string | null;
  /** ISO date string; the vault renders it as "Oct 19". */
  updatedAt: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  docType: string | null;
  href: string;
};

export type VaultUpload = { key: string; name: string; state: "busy" | "done" | "error"; note?: string };

const toneClass: Record<VaultDocument["status"]["tone"], string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  attention: "text-amber-700 dark:text-amber-400",
  done: "text-teal-700 dark:text-teal-400",
  error: "text-destructive",
};

const motionConfig = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] as const };

const dateFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function sizeLabel(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Box-style type-colored glyph: red PDF, blue image, teal web page, grey file. */
function DocGlyph({ doc, className }: { doc: Pick<VaultDocument, "kind" | "mimeType">; className?: string }) {
  const cls = cn("shrink-0", className);
  if (doc.kind === "web_page") return <Globe className={cn(cls, "text-teal-600 dark:text-teal-400")} aria-hidden />;
  if (doc.mimeType?.startsWith("image/")) return <FileImage className={cn(cls, "text-sky-600 dark:text-sky-400")} aria-hidden />;
  if (doc.mimeType === "application/pdf") return <FileText className={cn(cls, "text-red-600 dark:text-red-400")} aria-hidden />;
  return <FileText className={cn(cls, "text-muted-foreground")} aria-hidden />;
}

function docSubtitle(doc: Pick<VaultDocument, "kind" | "mimeType" | "filename" | "sourceUrl">): string {
  if (doc.kind === "web_page" && doc.sourceUrl) {
    try {
      return new URL(doc.sourceUrl).hostname;
    } catch {
      return "Web page";
    }
  }
  const type = doc.mimeType === "application/pdf" ? "PDF" : doc.mimeType?.startsWith("image/") ? "Image" : "File";
  return doc.filename ?? type;
}

/** The directory path a picked file belongs to, from its webkitRelativePath. */
function dirOf(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  const parts = relativePath.split("/");
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join("/");
}

export function DocumentVault({
  folders,
  documents,
  currentFolderId,
  breadcrumb,
}: {
  folders: VaultFolder[];
  documents: VaultDocument[];
  currentFolderId: string | null;
  breadcrumb: { name: string; href: string | null }[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<VaultUpload[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const visibleFolders = useMemo(
    () => folders.filter((f) => f.parentId === currentFolderId && f.name.toLowerCase().includes(query.toLowerCase())),
    [folders, currentFolderId, query],
  );
  const visibleDocuments = useMemo(
    () => documents.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()) || (d.filename ?? "").toLowerCase().includes(query.toLowerCase())),
    [documents, query],
  );
  const selected = visibleDocuments.find((d) => d.id === selectedId) ?? null;

  const upload = useCallback(
    async (file: File, folderPath: string | null) => {
      const key = `${file.name}-${crypto.randomUUID()}`;
      setUploads((prev) => [...prev, { key, name: file.name, state: "busy" }]);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("title", file.name.replace(/\.[^.]+$/, "") || file.name);
        if (folderPath) body.append("folderPath", folderPath);
        const response = await fetch("/api/v1/files", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body,
        });
        const payload = (await response.json().catch(() => null)) as { fileStatus?: string; title?: string } | null;
        if (!response.ok) {
          const problem = payload && "title" in payload ? payload.title : null;
          throw new Error(problem ?? `${file.name} could not be uploaded (${response.status}).`);
        }
        if (payload && payload.fileStatus === "quarantined") {
          throw new Error(`We kept ${file.name} but couldn't identify its type, so no document was created.`);
        }
        setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, state: "done" } : u)));
        router.refresh();
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : `${file.name} could not be uploaded — network error.`;
        setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, state: "error", note: text } : u)));
      }
    },
    [router],
  );

  const uploadFiles = useCallback(
    async (list: FileList | File[], withPaths: boolean) => {
      setPlusOpen(false);
      for (const file of Array.from(list)) {
        const path = withPaths ? dirOf((file as File & { webkitRelativePath?: string }).webkitRelativePath) : null;
        await upload(file, path);
      }
    },
    [upload],
  );

  // The whole surface is a dropzone. A directory drop carries entries with
  // full paths; files dropped from outside a folder window do not.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    };
    const onDrop = async (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const items = event.dataTransfer?.items;
      if (items && items.length > 0) {
        const entries = Array.from(items)
          .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
          .filter(Boolean) as FileSystemEntry[];
        if (entries.length > 0) {
          await collectEntries(entries, (file, path) => upload(file, path));
          return;
        }
      }
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) await uploadFiles(files, false);
    };
    root.addEventListener("dragenter", onDragEnter);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    return () => {
      root.removeEventListener("dragenter", onDragEnter);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
    };
  }, [upload, uploadFiles]);

  const openViewer = (id: string) => {
    setSelectedId(id);
  };

  const empty = visibleFolders.length === 0 && visibleDocuments.length === 0 && uploads.length === 0;

  return (
    <div ref={rootRef} className="relative flex min-h-[60vh] flex-col gap-3">
      {/* One toolbar: search and the quiet +. Nothing else lives here. */}
      <div className="flex items-center gap-2">
        <div className="border-input bg-background focus-within:ring-ring relative min-w-0 flex-1 rounded-md border transition-shadow focus-within:ring-3">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files and folders"
            aria-label="Search files and folders"
            className="min-h-9 w-full bg-transparent pl-8 pr-3 text-[13px] outline-none"
          />
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="New"
            aria-expanded={plusOpen}
            aria-haspopup="menu"
            onClick={() => setPlusOpen((open) => !open)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1 rounded-md pr-2.5 pl-2 text-[13px] font-medium transition-colors active:scale-[0.98]"
          >
            <motion.span animate={{ rotate: plusOpen ? 45 : 0 }} transition={motionConfig} className="grid place-items-center">
              <Plus className="size-4" aria-hidden />
            </motion.span>
            New
          </button>
          <AnimatePresence>
            {plusOpen ? (
              <motion.div
                role="menu"
                aria-label="New"
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={motionConfig}
                className="bg-popover text-popover-foreground border-border absolute right-0 z-20 mt-1 w-52 rounded-md border p-1 shadow-sm"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => fileInput.current?.click()}
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none"
                >
                  <Plus className="size-3.5" aria-hidden /> Upload files
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => folderInput.current?.click()}
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none"
                >
                  <FolderUp className="size-3.5" aria-hidden /> Upload a folder
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Breadcrumb: where in the vault you are. */}
      <div className="flex min-h-6 items-center gap-1 text-[13px]">
        {breadcrumb.map((crumb, index) => (
          <span key={crumb.name} className="flex items-center gap-1">
            {index > 0 ? <ChevronRight className="text-muted-foreground size-3" aria-hidden /> : null}
            {crumb.href ? (
              <a href={crumb.href} className="text-muted-foreground underline-offset-4 hover:underline">
                {crumb.name}
              </a>
            ) : (
              <span className="font-medium">{crumb.name}</span>
            )}
          </span>
        ))}
      </div>

      {/* Drop acknowledgement: one surface-level signal, not per-row. */}
      <AnimatePresence>
        {dragging ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionConfig}
            role="status"
            className="border-ring bg-accent/40 text-accent-foreground pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed text-[13px] font-medium"
          >
            Drop to file into {breadcrumb[breadcrumb.length - 1]?.name ?? "the vault"} — folders keep their structure, reading starts on its own.
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Uploads in flight: partial stays partial, each row reports its own state. */}
      <AnimatePresence>
        {uploads.length > 0 ? (
          <motion.ul initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-1" aria-label="Uploading">
            {uploads.map((item) => (
              <motion.li
                key={item.key}
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={motionConfig}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-xs",
                  item.state === "error" ? "bg-destructive/10 text-destructive" : "bg-muted/60 text-muted-foreground",
                )}
              >
                <span className="min-w-0 truncate">{item.name}</span>
                <span className={cn("readout shrink-0", item.state === "error" && "text-destructive")}>
                  {item.state === "busy" ? "Reading…" : item.state === "done" ? "Added" : "Failed"}
                </span>
              </motion.li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>

      {empty ? (
        <div className="panel-empty flex flex-col items-center gap-1.5 rounded-md px-6 py-12 text-center">
          <p className="text-[13px] font-medium">The vault is empty</p>
          <p className="text-muted-foreground max-w-sm text-xs">
            Drop files or a folder anywhere on this surface, or use New. Polymath reads what arrives and proposes the fields — nothing is filed until you file it.
          </p>
        </div>
      ) : (
        <div className="flex gap-6">
          {/* The table: folders inline, then documents, under one header row. */}
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground border-border grid grid-cols-[minmax(0,1fr)_110px_84px_72px] items-center gap-3 border-b px-2 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
              <span>Name</span>
              <span>State</span>
              <span className="hidden sm:block">Updated</span>
              <span className="hidden text-right sm:block">Size</span>
            </div>

            {visibleFolders.map((folder) => (
              <a
                key={folder.id}
                href={`/alfred/knowledge?folder=${folder.id}`}
                className="hover:bg-muted/40 border-border grid grid-cols-[minmax(0,1fr)_110px_84px_72px] items-center gap-3 border-b px-2 py-2 transition-colors"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <FolderOpen className="text-muted-foreground size-4" aria-hidden />
                  <span className="truncate text-[13px] font-medium">{folder.name}</span>
                </span>
                <span className="text-muted-foreground text-xs">—</span>
                <span className="text-muted-foreground hidden text-xs sm:block">—</span>
                <Readout className="text-muted-foreground hidden text-right text-xs sm:block">{folder.documentCount}</Readout>
              </a>
            ))}

            <motion.ul layout className="flex flex-col" aria-label="Documents">
              <AnimatePresence initial={false}>
                {visibleDocuments.map((doc) => (
                  <motion.li
                    key={doc.id}
                    layout
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={motionConfig}
                    className="border-border border-b last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => openViewer(doc.id)}
                      aria-haspopup="dialog"
                      className="hover:bg-muted/40 grid w-full grid-cols-[minmax(0,1fr)_110px_84px_72px] items-center gap-3 px-2 py-2 text-left transition-colors"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <DocGlyph doc={doc} className="size-4" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium">{doc.title}</span>
                          <span className="text-muted-foreground block truncate text-xs">{docSubtitle(doc)}</span>
                        </span>
                      </span>
                      <span className={cn("truncate text-xs font-medium", toneClass[doc.status.tone])}>{doc.status.label}</span>
                      <span className="text-muted-foreground hidden truncate text-xs sm:block">
                        {doc.updatedAt ? dateFmt.format(new Date(doc.updatedAt)) : "—"}
                      </span>
                      <Readout className="text-muted-foreground hidden text-right text-xs sm:block">{sizeLabel(doc.sizeBytes)}</Readout>
                    </button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
          </div>
        </div>
      )}

      <AnimatePresence>
        {selected ? <Viewer doc={selected} onClose={() => setSelectedId(null)} /> : null}
      </AnimatePresence>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".pdf,.png,.jpeg,.jpg,.webp,.txt,.md,.docx,.xlsx,.pptx"
        className="sr-only"
        aria-label="Choose documents to upload"
        onChange={(event) => {
          if (event.target.files?.length) void uploadFiles(event.target.files, false);
          event.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        // @ts-expect-error — webkitdirectory is the only directory picker on the platform.
        webkitdirectory=""
        directory=""
        className="sr-only"
        aria-label="Choose a folder to upload"
        onChange={(event) => {
          if (event.target.files?.length) void uploadFiles(event.target.files, true);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * Split viewer: the document's bytes left, its extracted text right. Opens in
 * place over the vault; Esc closes. A failed or missing read shows the reason
 * and a Retry control — the extraction route is idempotent by content hash,
 * so retry either runs the provider or returns the stored text, never a
 * duplicate.
 */
function Viewer({ doc, onClose }: { doc: VaultDocument; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [textState, setTextState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);

  const loadText = useCallback(async () => {
    setTextState("loading");
    try {
      const response = await fetch(`/api/v1/documents/${doc.id}/text`);
      if (!response.ok) {
        setTextState("empty");
        return;
      }
      const body = await response.text();
      setText(body);
      setTextState(body.trim() ? "ready" : "empty");
    } catch {
      setTextState("error");
    }
  }, [doc.id]);

  // Fire the first read from render when idle; every other transition is
  // event-driven (retry click), so no state is set inside an effect body.
  if (textState === "idle") {
    setTextState("loading");
    void loadText();
  }

  async function retryExtraction() {
    setRetrying(true);
    setRetryNote(null);
    try {
      const response = await fetch(`/api/v1/documents/${doc.id}/extract`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setRetryNote(payload?.error ?? `Reading failed (${response.status}).`);
        return;
      }
      await loadText();
      setRetryNote("Read complete.");
    } catch {
      setRetryNote("Reading failed — network error.");
    } finally {
      setRetrying(false);
    }
  }

  // Esc closes; the overlay is the only modal on the surface.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inline = doc.kind === "file" && (doc.mimeType === "application/pdf" || doc.mimeType?.startsWith("image/"));

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`${doc.title} viewer`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={motionConfig}
      className="bg-foreground/20 fixed inset-0 z-40 p-2 sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.99 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.99 }}
        transition={motionConfig}
        className="bg-background border-border mx-auto flex size-full max-w-[1400px] flex-col overflow-hidden rounded-lg border shadow-sm"
        onClick={(event) => event.stopPropagation()}
      >
      <div className="border-border flex min-h-12 items-center gap-3 border-b px-4">
        <DocGlyph doc={doc} className="size-4" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{doc.title}</p>
        <span className={cn("shrink-0 text-xs font-medium", toneClass[doc.status.tone])}>{doc.status.label}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
          className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md p-1.5 transition-colors"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="border-border bg-muted/30 relative min-h-0 border-r">
          {inline ? (
            <iframe
              src={`/api/v1/documents/${doc.id}/file`}
              title={doc.title}
              className="absolute inset-0 size-full"
            />
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs">
              <DocGlyph doc={doc} className="size-8" />
              {doc.kind === "web_page" && doc.sourceUrl ? (
                <>
                  <p>This document is a captured web page.</p>
                  <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    Open the original
                  </a>
                </>
              ) : (
                <p>No preview for this file type — the extracted text is on the right.</p>
              )}
            </div>
          )}
        </div>
        <div className="relative min-h-0 overflow-y-auto">
          {textState === "loading" ? (
            <div role="status" className="text-muted-foreground flex items-center gap-2 p-4 text-xs">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Reading the extracted text…
            </div>
          ) : textState === "ready" ? (
            <pre className="text-foreground/90 p-4 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{text}</pre>
          ) : (
            <div className="flex h-full flex-col items-start gap-3 p-4">
              <p className="text-muted-foreground text-xs">
                {doc.status.tone === "error"
                  ? "This document could not be read. The reason is on its record — retrying runs the reader again."
                  : "The text has not been read yet. Retry runs the reader now; it is idempotent, so nothing is duplicated."}
              </p>
              {retryNote ? (
                <p role={retryNote.startsWith("Read") ? "status" : "alert"} className="text-muted-foreground text-xs">
                  {retryNote}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void retryExtraction()}
                disabled={retrying}
                className="border-input hover:bg-muted inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors active:scale-[0.98] disabled:opacity-60"
              >
                <RotateCw className={cn("size-3.5", retrying && "animate-spin")} aria-hidden />
                {retrying ? "Reading…" : "Retry extraction"}
              </button>
            </div>
          )}
        </div>
      </div>
      </motion.div>
    </motion.div>
  );
}

/** Walk a directory drop in place, collecting files with their relative paths. */
async function collectEntries(
  entries: FileSystemEntry[],
  emit: (file: File, path: string | null) => Promise<void> | void,
): Promise<void> {
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(
          (f) => resolve(f),
          () => resolve(null),
        ),
      );
      if (file) await emit(file, entry.fullPath.replace(/^\//, ""));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children = await new Promise<FileSystemEntry[]>((resolve) => {
        const acc: FileSystemEntry[] = [];
        const readBatch = () =>
          reader.readEntries(
            (batch) => {
              if (batch.length === 0) return resolve(acc);
              acc.push(...batch);
              readBatch();
            },
            () => resolve(acc),
          );
        readBatch();
      });
      await collectEntries(children, (file, path) => emit(file, `${entry.name}/${path}`));
    }
  }
}
