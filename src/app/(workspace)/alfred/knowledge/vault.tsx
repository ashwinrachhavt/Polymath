"use client";

import { AnimatePresence, motion } from "motion/react";
import { motionTransition } from "@/components/motion-config";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronRight,
  FileImage,
  FileText,
  FolderOpen,
  FolderPlus,
  Globe,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  RotateCw,
  Search,
  FolderUp,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Readout } from "@/components/readout";
import { vaultReview, type VaultReview, type VaultStateKey, type VaultTone } from "@/domains/knowledge/vault-review";
import { phaseForReadiness } from "@/domains/knowledge/readiness-batch";
import type { SourceReadiness } from "@/domains/knowledge/source-readiness";
import { createVaultFolder } from "./actions";
import { StatementStrip } from "./statement-section";

/*
 * The document vault, on the Drive pattern: breadcrumb, review filter, sort
 * and a list/grid switch over the same rows. The whole surface is a dropzone —
 * dropped folders keep their structure, and reading starts on its own. A
 * selected row opens the split viewer: the document on the left, the extracted
 * text on the right.
 *
 * "Review" is the only state the browser volunteers. The review workbench owns
 * the pipeline vocabulary (proposed / filed); the vault says "Needs review"
 * only when the owner can act, and leaves a filed row quiet. The filter is the
 * inbox view, so a state is always one click away, never just a label.
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
  /** The status.ts key, for the vault's review lens and filters. */
  reviewKey: VaultStateKey;
  undecidedProposals: number;
  sourceUrl: string | null;
  /** ISO date string; the vault renders it as "Oct 19". */
  updatedAt: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  docType: string | null;
  href: string;
};

export type VaultUpload = {
  key: string;
  name: string;
  state: "busy" | "done" | "error";
  /** Set once /api/v1/files returns 201; the poller then tracks the pipeline. */
  documentId?: string;
  /** Set when the poller hit its ceiling: the row stays honest but stops polling. */
  gaveUp?: boolean;
  /** What the row says right now — "Reading…", "Queued", a failure reason. */
  phase?: string;
  note?: string;
};

const toneClass: Record<VaultTone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  attention: "text-amber-700 dark:text-amber-400",
  done: "text-teal-700 dark:text-teal-400",
  error: "text-destructive",
};

const toneDot: Record<VaultTone, string> = {
  neutral: "bg-muted-foreground/50",
  progress: "bg-muted-foreground",
  attention: "bg-amber-600 dark:bg-amber-400",
  done: "bg-teal-600 dark:bg-teal-400",
  error: "bg-destructive",
};

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

/** What the document-type catalogue calls each type, for the row subtitle. */
const DOC_TYPE_LABELS: Record<string, string> = {
  statement: "Bank statement",
  invoice: "Invoice",
  receipt: "Receipt",
  agreement: "Agreement",
  resume: "Resume",
  letter: "Letter",
  report: "Report",
  form: "Form",
  other: "Document",
};

function docTypeLabel(doc: Pick<VaultDocument, "kind" | "mimeType" | "docType">): string {
  if (doc.kind === "web_page") return "Web page";
  if (doc.docType) return DOC_TYPE_LABELS[doc.docType] ?? "Document";
  if (doc.mimeType === "application/pdf") return "PDF";
  if (doc.mimeType?.startsWith("image/")) return "Image";
  return "File";
}

function docSubtitle(doc: Pick<VaultDocument, "kind" | "mimeType" | "filename" | "sourceUrl" | "docType">): string {
  const typeLabel = doc.docType ? DOC_TYPE_LABELS[doc.docType] : undefined;
  let base: string;
  if (doc.kind === "web_page" && doc.sourceUrl) {
    try {
      base = new URL(doc.sourceUrl).hostname;
    } catch {
      base = "Web page";
    }
  } else {
    const type = doc.mimeType === "application/pdf" ? "PDF" : doc.mimeType?.startsWith("image/") ? "Image" : "File";
    base = doc.filename ?? type;
  }
  return typeLabel ? `${typeLabel} · ${base}` : base;
}

/** The card caption: type and date — what a 168px card can actually hold. */
function docMeta(doc: Pick<VaultDocument, "kind" | "mimeType" | "docType" | "updatedAt">): string {
  return [docTypeLabel(doc), doc.updatedAt ? dateFmt.format(new Date(doc.updatedAt)) : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

type ViewMode = "list" | "grid";
type VaultFilter = "all" | "review" | "unread";
type VaultSort = "modified" | "name" | "size";

const VIEW_KEY = "axiom.knowledge.view";
const VIEW_EVENT = "axiom:knowledge-view";

const FILTERS: Array<{ id: VaultFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "unread", label: "Not read" },
];

const SORTS: Array<{ id: VaultSort; label: string }> = [
  { id: "modified", label: "Last modified" },
  { id: "name", label: "Name" },
  { id: "size", label: "Size" },
];

function subscribeView(callback: () => void) {
  window.addEventListener(VIEW_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(VIEW_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function readView(): ViewMode {
  return window.localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
}

function matchesFilter(doc: VaultDocument, filter: VaultFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return doc.reviewKey === "added";
  return vaultReview(doc.reviewKey, doc.undecidedProposals)?.needsReview === true;
}

function sortDocuments(documents: VaultDocument[], sort: VaultSort): VaultDocument[] {
  const copy = [...documents];
  if (sort === "name") {
    return copy.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
  }
  if (sort === "size") {
    return copy.sort(
      (a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
    );
  }
  return copy.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bt - at || a.title.localeCompare(b.title, "en", { sensitivity: "base" });
  });
}

/** The directory path a picked file belongs to, from its webkitRelativePath. */
function dirOf(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  const parts = relativePath.split("/");
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join("/");
}

/** The one state the browser volunteers: a word, a dot, and the reason on hover. */
function ReviewCell({ review }: { review: VaultReview | null }) {
  if (!review) return <span aria-hidden />;
  return (
    <span
      title={review.detail}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium", toneClass[review.tone])}
    >
      {review.tone === "progress" ? (
        <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden />
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[review.tone])} aria-hidden />
      )}
      <span className="truncate">{review.label}</span>
    </span>
  );
}

/** A grid card's preview plate: the image itself, or the type glyph on paper. */
function DocumentPlate({ doc }: { doc: VaultDocument }) {
  const [failed, setFailed] = useState(false);
  const image = doc.kind === "file" && doc.mimeType?.startsWith("image/");
  return (
    <div className="border-border/70 bg-muted/20 group-hover:border-foreground/20 relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border transition-colors">
      {image && !failed ? (
        // The private-bytes route is same-origin and session-scoped; the image
        // is lazy so a large vault does not read every original at once.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/v1/documents/${doc.id}/file`}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <DocGlyph doc={doc} className="size-8 opacity-80" />
      )}
      {doc.pageCount ? (
        <span className="readout bg-background/85 text-muted-foreground absolute right-1.5 bottom-1.5 rounded-sm px-1 py-0.5 text-[10px]">
          {doc.pageCount} pp
        </span>
      ) : null}
    </div>
  );
}

const ROW_GRID = "grid-cols-[minmax(0,1fr)_112px] sm:grid-cols-[minmax(0,1fr)_112px_84px_72px]";

function ListView({
  folders,
  documents,
  onOpen,
}: {
  folders: VaultFolder[];
  documents: VaultDocument[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "text-muted-foreground border-border grid items-center gap-3 border-b px-2 pb-1.5 text-[11px] font-medium tracking-wide uppercase",
          ROW_GRID,
        )}
      >
        <span>Name</span>
        <span title="Only exceptions get a word here. A filed document stays quiet.">Review</span>
        <span className="hidden sm:block">Modified</span>
        <span className="hidden text-right sm:block">Size</span>
      </div>

      {folders.map((folder) => (
        <Link
          key={folder.id}
          href={`/alfred/knowledge?folder=${folder.id}`}
          className={cn(
            "hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-ring/50 border-border grid items-center gap-3 border-b px-2 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
            ROW_GRID,
          )}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <FolderOpen className="text-muted-foreground size-4" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{folder.name}</span>
              <span className="text-muted-foreground block truncate text-xs">
                Folder · {folder.documentCount} {folder.documentCount === 1 ? "document" : "documents"}
              </span>
            </span>
          </span>
          <span aria-hidden />
          <span className="text-muted-foreground hidden text-xs sm:block">—</span>
          <span className="text-muted-foreground hidden text-right text-xs sm:block">—</span>
        </Link>
      ))}

      <motion.ul layout className="flex flex-col" aria-label="Documents">
        <AnimatePresence initial={false}>
          {documents.map((doc) => (
            <motion.li
              key={doc.id}
              layout
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={motionTransition}
              className="border-border border-b last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onOpen(doc.id)}
                aria-haspopup="dialog"
                title={doc.title}
                className={cn(
                  "hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-ring/50 grid w-full items-center gap-3 px-2 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  ROW_GRID,
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <DocGlyph doc={doc} className="size-4" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{doc.title}</span>
                    <span className="text-muted-foreground block truncate text-xs">{docSubtitle(doc)}</span>
                  </span>
                </span>
                <ReviewCell review={vaultReview(doc.reviewKey, doc.undecidedProposals)} />
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
  );
}

function GridView({
  folders,
  documents,
  onOpen,
}: {
  folders: VaultFolder[];
  documents: VaultDocument[];
  onOpen: (id: string) => void;
}) {
  return (
    <ul
      className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-6"
      aria-label="Files and folders"
    >
      {folders.map((folder) => (
        <li key={folder.id} className="min-w-0">
          <Link
            href={`/alfred/knowledge?folder=${folder.id}`}
            className="group focus-visible:ring-ring/50 flex h-full min-w-0 flex-col gap-2 rounded-md outline-none focus-visible:ring-2"
          >
            <div className="border-border/70 bg-muted/20 group-hover:border-foreground/20 grid aspect-[4/3] place-items-center rounded-md border transition-colors">
              <FolderOpen className="text-muted-foreground size-9" strokeWidth={1.5} aria-hidden />
            </div>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{folder.name}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {folder.documentCount} {folder.documentCount === 1 ? "document" : "documents"}
              </span>
            </span>
          </Link>
        </li>
      ))}

      {documents.map((doc) => {
        const review = vaultReview(doc.reviewKey, doc.undecidedProposals);
        return (
          <li key={doc.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(doc.id)}
              aria-haspopup="dialog"
              title={doc.title}
              className="group focus-visible:ring-ring/50 flex h-full w-full min-w-0 flex-col gap-2 rounded-md text-left outline-none focus-visible:ring-2"
            >
              <DocumentPlate doc={doc} />
              <span className="flex min-w-0 items-start gap-2">
                <DocGlyph doc={doc} className="mt-0.5 size-4" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{doc.title}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {review ? (
                      <>
                        <span className={cn(review.needsReview && "font-medium", toneClass[review.tone])}>
                          {review.label}
                        </span>
                        {" · "}
                      </>
                    ) : null}
                    {docMeta(doc)}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
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
  const [filter, setFilter] = useState<VaultFilter>("all");
  const [sort, setSort] = useState<VaultSort>("modified");
  const view = useSyncExternalStore(subscribeView, readView, () => "list" as ViewMode);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<VaultUpload[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [createdFolder, setCreatedFolder] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(
    () => ({
      all: documents.length,
      review: documents.filter((doc) => matchesFilter(doc, "review")).length,
      unread: documents.filter((doc) => matchesFilter(doc, "unread")).length,
    }),
    [documents],
  );

  const visibleFolders = useMemo(() => {
    if (filter !== "all") return [];
    const q = query.trim().toLowerCase();
    return folders.filter((f) => f.parentId === currentFolderId && (!q || f.name.toLowerCase().includes(q)));
  }, [folders, currentFolderId, query, filter]);

  const visibleDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = documents.filter(
      (doc) =>
        matchesFilter(doc, filter) &&
        (!q || doc.title.toLowerCase().includes(q) || (doc.filename ?? "").toLowerCase().includes(q)),
    );
    return sortDocuments(matching, sort);
  }, [documents, query, filter, sort]);

  const selected = visibleDocuments.find((d) => d.id === selectedId) ?? null;
  const currentName = currentFolderId ? (breadcrumb[breadcrumb.length - 1]?.name ?? "this folder") : "the vault";
  const filtering = filter !== "all" || query.trim().length > 0;
  const emptyVault = folders.length === 0 && documents.length === 0 && uploads.length === 0;
  const noMatches = visibleFolders.length === 0 && visibleDocuments.length === 0;

  const chooseView = (next: ViewMode) => {
    window.localStorage.setItem(VIEW_KEY, next);
    window.dispatchEvent(new Event(VIEW_EVENT));
  };

  const openNewFolder = () => {
    setPlusOpen(false);
    setFolderName("");
    setFolderError(null);
    setNewFolderOpen(true);
  };

  async function submitNewFolder() {
    const name = folderName.trim();
    if (!name) {
      setFolderError("A folder needs a name.");
      return;
    }
    setFolderBusy(true);
    setFolderError(null);
    try {
      const result = await createVaultFolder(name, currentFolderId);
      if (!result.ok) {
        setFolderError(result.error);
        return;
      }
      setNewFolderOpen(false);
      setFolderName("");
      // A new folder is only useful if it is visible: drop any review filter
      // or search that would hide it, then let the server list pick it up.
      setFilter("all");
      setQuery("");
      setCreatedFolder(result.name);
      router.refresh();
    } catch {
      setFolderError("The folder could not be created. Try again.");
    } finally {
      setFolderBusy(false);
    }
  }

  const showEverything = () => {
    setFilter("all");
    setQuery("");
  };

  const upload = useCallback(
    async (file: File, folderPath: string | null) => {
      const key = `${file.name}-${crypto.randomUUID()}`;
      setUploads((prev) => [...prev, { key, name: file.name, state: "busy" }]);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("title", file.name.replace(/\.[^.]+$/, "") || file.name);
        // Files picked while inside a folder file into that folder; a dropped
        // directory keeps its relative structure underneath it.
        if (currentFolderId) body.append("folderId", currentFolderId);
        if (folderPath) body.append("folderPath", folderPath);
        const response = await fetch("/api/v1/files", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body,
        });
        const payload = (await response.json().catch(() => null)) as
          | { documentId?: string; fileStatus?: string; title?: string }
          | null;
        if (!response.ok) {
          const problem = payload && "title" in payload ? payload.title : null;
          throw new Error(problem ?? `${file.name} could not be uploaded (${response.status}).`);
        }
        if (payload && payload.fileStatus === "quarantined") {
          throw new Error(`We kept ${file.name} but couldn't identify its type, so no document was created.`);
        }
        if (payload?.documentId) {
          // The bytes landed; reading and indexing come next. Keep the row busy
          // and let the readiness poller move it to Ready or a failure reason.
          setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, documentId: payload.documentId, phase: "Reading…" } : u)));
        } else {
          setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, state: "done" } : u)));
        }
        router.refresh();
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : `${file.name} could not be uploaded. Check the connection and try again.`;
        setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, state: "error", note: text } : u)));
      }
    },
    [router, currentFolderId],
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

  // While any upload row has a document, poll the readiness projection every
  // 2 s and move the row: Queued → Reading… → Indexing for search… → Ready, or
  // a failure reason. Five minutes per batch is the ceiling — after that the
  // row says honestly that the vault will catch up on its own, and polling
  // stops instead of spinning forever against a stuck queue.
  const pendingIds = useMemo(
    () =>
      uploads
        .filter((u) => u.state === "busy" && u.documentId && !u.gaveUp)
        .map((u) => u.documentId as string),
    [uploads],
  );
  const gaveUpRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (pendingIds.length === 0) return;
    const pollIds = pendingIds;
    const startedAt = Date.now();
    const POLL_MS = 2_000;
    const GIVE_UP_MS = 5 * 60_000;

    const tick = async () => {
      if (Date.now() - startedAt > GIVE_UP_MS) {
        // Ceiling reached: these rows say honestly that the vault will catch up
        // on its own, and the poller excludes them instead of spinning forever.
        for (const id of pollIds) gaveUpRef.current.add(id);
        setUploads((prev) =>
          prev.map((u) =>
            u.state === "busy" && u.documentId && pollIds.includes(u.documentId)
              ? { ...u, gaveUp: true, phase: "Still reading — the vault row will update on its own." }
              : u,
          ),
        );
        return;
      }
      try {
        const response = await fetch(`/api/v1/documents/readiness?ids=${pollIds.join(",")}`);
        if (!response.ok) return; // transient; the next tick retries
        const body = (await response.json()) as {
          sources?: Array<{ documentId: string; readiness: SourceReadiness; detail: string | null }>;
        };
        const byId = new Map((body.sources ?? []).map((s) => [s.documentId, s]));
        setUploads((prev) =>
          prev.map((u) => {
            if (u.state !== "busy" || !u.documentId) return u;
            const source = byId.get(u.documentId);
            if (!source) return u;
            const { phase, terminal } = phaseForReadiness(source.readiness, source.detail);
            if (!terminal) return { ...u, phase };
            return terminal === "done" ? { ...u, phase, state: "done" } : { ...u, phase, state: "error" };
          }),
        );
      } catch {
        // The poller is a status read, not a mutation: a failed tick is silent
        // and the next interval retries. Swallowing here is the honest choice.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [pendingIds]);

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
          // collectEntries reports each file's full relative path; the upload
          // wants the directory above it, or the filename becomes a folder.
          await collectEntries(entries, (file, path) => upload(file, dirOf(path)));
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

  // The New menu behaves like a menu: Escape or a click anywhere outside it
  // closes it. The ref wraps the trigger too, so this does not fight the
  // trigger's own toggle.
  useEffect(() => {
    if (!plusOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) setPlusOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlusOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [plusOpen]);

  const openViewer = (id: string) => {
    setSelectedId(id);
  };

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
        <div ref={plusRef} className="relative shrink-0">
          <Button
            type="button"
            size="lg"
            aria-label="New"
            aria-expanded={plusOpen}
            aria-haspopup="menu"
            onClick={() => setPlusOpen((open) => !open)}
            className="pr-2.5 pl-2"
          >
            <motion.span animate={{ rotate: plusOpen ? 45 : 0 }} transition={motionTransition} className="grid place-items-center">
              <Plus className="size-4" aria-hidden />
            </motion.span>
            New
          </Button>
          <AnimatePresence>
            {plusOpen ? (
              <motion.div
                role="menu"
                aria-label="New"
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={motionTransition}
                className="bg-popover text-popover-foreground border-border absolute right-0 z-20 mt-1 w-52 rounded-md border p-1 shadow-sm"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={openNewFolder}
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none"
                >
                  <FolderPlus className="size-3.5" aria-hidden /> New folder
                </button>
                <div className="bg-border my-1 h-px" aria-hidden />
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

      {/* Location and the controls that describe the current view. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <nav aria-label="Breadcrumb" className="flex min-h-6 min-w-0 flex-1 items-center gap-1 text-[13px]">
          {breadcrumb.map((crumb, index) => (
            <span key={`${crumb.name}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="text-muted-foreground size-3 shrink-0" aria-hidden /> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="text-muted-foreground truncate underline-offset-4 hover:underline">
                  {crumb.name}
                </Link>
              ) : (
                <span className="truncate font-medium">{crumb.name}</span>
              )}
            </span>
          ))}
        </nav>

        <div role="group" aria-label="Filter documents" className="flex shrink-0 items-center gap-0.5">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors",
                filter === item.id ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {item.label}
              <span className="text-muted-foreground text-[11px] tabular-nums">{counts[item.id]}</span>
            </button>
          ))}
        </div>

        <Select
          variant="ghost"
          aria-label="Sort documents"
          value={sort}
          onChange={(event) => setSort(event.target.value as VaultSort)}
          className="w-40 shrink-0"
        >
          {SORTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>

        <div role="group" aria-label="View" className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="List view"
            title="List view"
            aria-pressed={view === "list"}
            onClick={() => chooseView("list")}
            className={cn(
              "grid size-8 place-items-center rounded-md transition-colors",
              view === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <List className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Grid view"
            title="Grid view"
            aria-pressed={view === "grid"}
            onClick={() => chooseView("grid")}
            className={cn(
              "grid size-8 place-items-center rounded-md transition-colors",
              view === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <LayoutGrid className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Creation is acknowledged here; the tile itself arrives with the
          server refresh, which can be below the fold in a long folder. */}
      <AnimatePresence>
        {createdFolder ? (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={motionTransition}
            className="border-border bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
          >
            <FolderPlus className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Folder “{createdFolder}” created.</span>
            <button
              type="button"
              onClick={() => setCreatedFolder(null)}
              aria-label="Dismiss"
              className="hover:text-foreground rounded-sm p-0.5 transition-colors"
            >
              <X className="size-3" aria-hidden />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Drop acknowledgement: one surface-level signal, not per-row. */}
      <AnimatePresence>
        {dragging ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionTransition}
            role="status"
            className="border-ring bg-accent/40 text-accent-foreground pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed text-[13px] font-medium"
          >
            Drop to file into {currentName}. Folders keep their structure, reading starts on its own.
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
                transition={motionTransition}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-xs",
                  item.state === "error" ? "bg-destructive/10 text-destructive" : "bg-muted/60 text-muted-foreground",
                )}
              >
                <span className="min-w-0 truncate" title={item.state === "error" || item.phase ? item.phase ?? item.note : undefined}>
                  {item.name}
                </span>
                <span className={cn("readout shrink-0", item.state === "error" && "text-destructive")}>
                  {item.state === "busy"
                    ? item.phase ?? "Reading…"
                    : item.state === "done"
                      ? item.phase ?? "Added"
                      : item.phase ?? "Failed"}
                </span>
              </motion.li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>

      {emptyVault ? (
        <div className="panel-empty flex flex-col items-center gap-1.5 rounded-md px-6 py-12 text-center">
          <p className="text-[13px] font-medium">The vault is empty</p>
          <p className="text-muted-foreground max-w-sm text-xs">
            Drop files or a folder anywhere on this surface, or use New. Polymath reads what arrives and proposes the fields. Nothing is filed until you file it.
          </p>
        </div>
      ) : noMatches && uploads.length === 0 ? (
        <div className="panel-empty flex flex-col items-center gap-2 rounded-md px-6 py-12 text-center">
          <p className="text-[13px] font-medium">{filtering ? "Nothing here matches" : `Nothing in ${currentName} yet`}</p>
          <p className="text-muted-foreground max-w-sm text-xs">
            {filtering
              ? "Clear the search or pick another review filter."
              : "Drop files here, or use New to add something."}
          </p>
          {filtering ? (
            <Button type="button" variant="outline" onClick={showEverything} className="mt-1">
              Show everything
            </Button>
          ) : null}
        </div>
      ) : view === "grid" ? (
        <GridView folders={visibleFolders} documents={visibleDocuments} onOpen={openViewer} />
      ) : (
        <ListView folders={visibleFolders} documents={visibleDocuments} onOpen={openViewer} />
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

      <Dialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setFolderError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {currentFolderId ? `Inside ${currentName}.` : "At the top of the vault."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitNewFolder();
            }}
          >
            <Input
              autoFocus
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              maxLength={120}
              aria-label="Folder name"
              placeholder="Folder name"
              aria-invalid={folderError ? true : undefined}
            />
            {folderError ? (
              <p role="alert" className="text-destructive text-xs">
                {folderError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewFolderOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={folderBusy || !folderName.trim()}>
                {folderBusy ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
      setRetryNote("Reading failed. Check the connection and try again.");
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
  const review = vaultReview(doc.reviewKey, doc.undecidedProposals);
  const textNote =
    textState === "error"
      ? "The extracted text could not be loaded. Retrying runs the reader again and reloads the panel."
      : doc.reviewKey === "could_not_read"
        ? "This document could not be read. Retrying runs the reader again; a successful read is reused, not duplicated."
        : doc.reviewKey === "reading"
          ? "The read is still running. This panel fills in when it finishes; retrying is safe."
          : "No text has been read from this document yet. Retrying runs the reader now; it is idempotent, so nothing is duplicated.";

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`${doc.title} viewer`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={motionTransition}
      className="bg-foreground/20 fixed inset-0 z-40 p-2 sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.99 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.99 }}
        transition={motionTransition}
        className="bg-background border-border mx-auto flex size-full max-w-[1400px] flex-col overflow-hidden rounded-lg border shadow-sm"
        onClick={(event) => event.stopPropagation()}
      >
      <div className="border-border flex min-h-12 items-center gap-3 border-b px-4">
        <DocGlyph doc={doc} className="size-4" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{doc.title}</p>
        <span
          title={review?.detail}
          className={cn("shrink-0 text-xs font-medium", toneClass[review?.tone ?? "done"])}
        >
          {review?.label ?? "Filed"}
        </span>
        {/* The review workbench is where field proposals get accepted or
            corrected; the vault list replaced the old row links, so this is
            the surviving way in. */}
        <Link href={doc.href} className="shrink-0 text-xs font-medium underline-offset-4 hover:underline">
          Review fields
        </Link>
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
                <p>No preview for this file type. The extracted text is on the right.</p>
              )}
            </div>
          )}
        </div>
        <div className="relative min-h-0 overflow-y-auto">
          <StatementStrip documentId={doc.id} />
          {textState === "loading" ? (
            <div role="status" className="text-muted-foreground flex items-center gap-2 p-4 text-xs">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Reading the extracted text…
            </div>
          ) : textState === "ready" ? (
            <pre className="text-foreground/90 p-4 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{text}</pre>
          ) : (
            <div className="flex h-full flex-col items-start gap-3 p-4">
              <p className="text-muted-foreground text-xs">{textNote}</p>
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
