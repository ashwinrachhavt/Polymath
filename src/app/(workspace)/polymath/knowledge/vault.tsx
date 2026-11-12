"use client";

import { AnimatePresence, motion } from "motion/react";
import { motionTransition } from "@/components/motion-config";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Check,
  ChevronRight,
  Copy as CopyIcon,
  Download,
  FileImage,
  FileText,
  FolderOpen,
  FolderPlus,
  Globe,
  LayoutGrid,
  List,
  Lightbulb,
  LoaderCircle,
  Pencil,
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
import { Markdown } from "@/components/markdown";
import { vaultReview, type VaultReview, type VaultStateKey, type VaultTone } from "@/domains/knowledge/vault-review";
import { phaseForReadiness } from "@/domains/knowledge/readiness-batch";
import type { SourceReadiness } from "@/domains/knowledge/source-readiness";
import { createVaultFolder, moveVaultDocuments, renameVaultFolder } from "./actions";
import { GenerationJobRows } from "@/components/jobs/generation-job-rows";
import { IconButton } from "@/components/ui/icon-button";
import { useZettelize, useZettelJobs } from "@/components/zettelize/zettel-jobs";
import { MAX_ZETTELIZE_SOURCES, zettelJobSubject } from "@/domains/capture/zettel-job-names";
import { isSettled, type GenerationJobView } from "@/domains/jobs/state";
import { StatementStrip } from "./statement-section";
import { randomId } from "@/lib/random-id";

/*
 * The document vault, on the Drive pattern: breadcrumb, one search field, sort
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

export type VaultFolder = {
  id: string;
  parentId: string | null;
  name: string;
  documentCount: number;
  /** Live folders directly inside this one. */
  folderCount: number;
  version: number;
};

/** "2 folders, 5 documents": what a folder holds, so an empty-looking parent is not called empty. */
function folderSummary(folder: Pick<VaultFolder, "documentCount" | "folderCount">): string {
  const docs = `${folder.documentCount} ${folder.documentCount === 1 ? "document" : "documents"}`;
  if (folder.folderCount === 0) return docs;
  return `${folder.folderCount} ${folder.folderCount === 1 ? "folder" : "folders"}, ${docs}`;
}

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
  version: number;
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
  attention: "text-(--tone-attention)",
  done: "text-(--tone-teal)",
  error: "text-destructive",
};

const toneDot: Record<VaultTone, string> = {
  neutral: "bg-muted-foreground/50",
  progress: "bg-muted-foreground",
  attention: "bg-(--tone-attention)",
  done: "bg-(--tone-teal)",
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
  if (doc.kind === "web_page") return <Globe className={cn(cls, "text-(--tone-teal)")} aria-hidden />;
  if (doc.mimeType?.startsWith("image/"))
    return <FileImage className={cn(cls, "text-sky-600 dark:text-sky-400")} aria-hidden />;
  if (doc.mimeType === "application/pdf")
    return <FileText className={cn(cls, "text-red-600 dark:text-red-400")} aria-hidden />;
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
type VaultSort = "modified" | "name" | "size";

const VIEW_KEY = "axiom.knowledge.view";
const VIEW_EVENT = "axiom:knowledge-view";

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

function needsReview(doc: VaultDocument): boolean {
  return vaultReview(doc.reviewKey, doc.undecidedProposals)?.needsReview === true;
}

function sortDocuments(documents: VaultDocument[], sort: VaultSort): VaultDocument[] {
  const copy = [...documents];
  if (sort === "name") {
    return copy.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
  }
  if (sort === "size") {
    return copy.sort(
      (a, b) =>
        (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
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
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
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
        <span className="readout bg-background/85 text-muted-foreground absolute right-1.5 bottom-1.5 rounded-sm px-1 py-0.5 text-data">
          {doc.pageCount} pp
        </span>
      ) : null}
    </div>
  );
}

const ROW_GRID = "grid-cols-[minmax(0,1fr)_112px] sm:grid-cols-[minmax(0,1fr)_112px_84px_72px]";

/** Which documents are picked for a bulk verb. `active` shows every box, not only the hovered one. */
type Selection = { ids: ReadonlySet<string>; toggle: (id: string) => void; active: boolean };

function SelectBox({ doc, selection, className }: { doc: VaultDocument; selection: Selection; className?: string }) {
  const checked = selection.ids.has(doc.id);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => selection.toggle(doc.id)}
      aria-label={`Select ${doc.title}`}
      className={cn(
        "size-3.5 shrink-0 cursor-pointer accent-[var(--primary)] transition-opacity duration-150 focus-visible:opacity-100 max-sm:size-4 max-sm:opacity-100",
        checked || selection.active ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
        className,
      )}
    />
  );
}

/** A folder's rename verb, shown on hover beside its row or tile. */
function RenameFolderButton({ folder, onRename }: { folder: VaultFolder; onRename: (folder: VaultFolder) => void }) {
  return (
    <IconButton
      label={`Rename ${folder.name}`}
      icon={<Pencil aria-hidden />}
      onClick={() => onRename(folder)}
      className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
    />
  );
}

function ListView({
  folders,
  documents,
  onOpen,
  selection,
  onRenameFolder,
}: {
  folders: VaultFolder[];
  documents: VaultDocument[];
  onOpen: (id: string) => void;
  selection: Selection;
  onRenameFolder: (folder: VaultFolder) => void;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "text-muted-foreground border-border grid items-center gap-3 border-b pr-2 pb-1.5 pl-[1.875rem] text-data font-medium",
          ROW_GRID,
        )}
      >
        <span>Name</span>
        <span title="Only exceptions get a word here. A filed document stays quiet.">Review</span>
        <span className="hidden sm:block">Modified</span>
        <span className="hidden text-right sm:block">Size</span>
      </div>

      {folders.map((folder) => (
        <div
          key={folder.id}
          className="group/row border-border hover:bg-muted/40 flex items-center border-b pr-1 transition-colors"
        >
          <Link
            href={`/polymath/knowledge?folder=${folder.id}`}
            className="focus-visible:bg-muted/60 focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 pl-[1.875rem] outline-none focus-visible:ring-2 focus-visible:ring-inset"
          >
            <FolderOpen className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-body-dense font-medium">{folder.name}</span>
              <span className="text-muted-foreground block truncate text-xs">{folderSummary(folder)}</span>
            </span>
          </Link>
          <RenameFolderButton folder={folder} onRename={onRenameFolder} />
        </div>
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
              className={cn(
                "group/row border-border hover:bg-muted/40 flex items-center gap-2 border-b pl-2 transition-colors last:border-b-0",
                selection.ids.has(doc.id) && "bg-muted/40",
              )}
            >
              <SelectBox doc={doc} selection={selection} />
              <button
                type="button"
                onClick={() => onOpen(doc.id)}
                aria-haspopup="dialog"
                title={doc.title}
                className={cn(
                  "focus-visible:bg-muted/60 focus-visible:ring-ring/50 grid min-w-0 flex-1 items-center gap-3 py-2 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  ROW_GRID,
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <DocGlyph doc={doc} className="size-4" />
                  <span className="min-w-0">
                    <span className="block truncate text-body-dense font-medium">{doc.title}</span>
                    <span className="text-muted-foreground block truncate text-xs">{docSubtitle(doc)}</span>
                  </span>
                </span>
                <ReviewCell review={vaultReview(doc.reviewKey, doc.undecidedProposals)} />
                <span className="text-muted-foreground hidden truncate text-xs sm:block">
                  {doc.updatedAt ? dateFmt.format(new Date(doc.updatedAt)) : "—"}
                </span>
                <Readout className="text-muted-foreground hidden text-right text-xs sm:block">
                  {sizeLabel(doc.sizeBytes)}
                </Readout>
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
  selection,
  onRenameFolder,
}: {
  folders: VaultFolder[];
  documents: VaultDocument[];
  onOpen: (id: string) => void;
  selection: Selection;
  onRenameFolder: (folder: VaultFolder) => void;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-6" aria-label="Files and folders">
      {folders.map((folder) => (
        <li key={folder.id} className="group/row relative min-w-0">
          <div className="absolute top-1 right-1 z-10">
            <RenameFolderButton folder={folder} onRename={onRenameFolder} />
          </div>
          <Link
            href={`/polymath/knowledge?folder=${folder.id}`}
            className="group focus-visible:ring-ring/50 flex h-full min-w-0 flex-col gap-2 rounded-md outline-none focus-visible:ring-2"
          >
            <div className="border-border/70 bg-muted/20 group-hover:border-foreground/20 grid aspect-[4/3] place-items-center rounded-md border transition-colors">
              <FolderOpen className="text-muted-foreground size-9" strokeWidth={1.5} aria-hidden />
            </div>
            <span className="min-w-0">
              <span className="block truncate text-body-dense font-medium">{folder.name}</span>
              <span className="text-muted-foreground block truncate text-xs">{folderSummary(folder)}</span>
            </span>
          </Link>
        </li>
      ))}

      {documents.map((doc) => {
        const review = vaultReview(doc.reviewKey, doc.undecidedProposals);
        return (
          <li key={doc.id} className="group/row relative min-w-0">
            <SelectBox doc={doc} selection={selection} className="absolute top-2 left-2 z-10" />
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
                  <span className="block truncate text-body-dense font-medium">{doc.title}</span>
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

/** Every folder with its full path, for the Move menu: "Taxes / 2025". */
function folderPaths(folders: VaultFolder[]): Array<{ id: string; path: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: VaultFolder): string => {
    const names = [folder.name];
    let parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    for (let depth = 0; parent && depth < 32; depth += 1) {
      names.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return names.join(" / ");
  };
  return folders
    .map((f) => ({ id: f.id, path: pathOf(f) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" }));
}

type FolderDialog = { mode: "new" } | { mode: "rename"; folder: VaultFolder } | null;

export function DocumentVault({
  folders,
  documents,
  currentFolderId,
  breadcrumb,
  zettelJobs,
  zettelProviderReady,
  zettelProviderReason,
}: {
  folders: VaultFolder[];
  documents: VaultDocument[];
  currentFolderId: string | null;
  breadcrumb: { name: string; href: string | null }[];
  /** Zettelize jobs still waiting or failed when the page rendered. */
  zettelJobs: GenerationJobView[];
  zettelProviderReady: boolean;
  zettelProviderReason: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<VaultSort>("modified");
  const view = useSyncExternalStore(subscribeView, readView, () => "list" as ViewMode);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<VaultUpload[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [createdFolder, setCreatedFolder] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialog>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const zettel = useZettelize();
  const zettelSurface = useZettelJobs(zettelJobs);
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
      review: documents.filter(needsReview).length,
      unread: documents.filter((doc) => doc.reviewKey === "added").length,
    }),
    [documents],
  );

  const visibleFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return folders.filter((f) => f.parentId === currentFolderId && (!q || f.name.toLowerCase().includes(q)));
  }, [folders, currentFolderId, query]);

  const visibleDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = documents.filter(
      (doc) => !q || doc.title.toLowerCase().includes(q) || (doc.filename ?? "").toLowerCase().includes(q),
    );
    return sortDocuments(matching, sort);
  }, [documents, query, sort]);

  const selected = visibleDocuments.find((d) => d.id === selectedId) ?? null;
  const currentFolder = currentFolderId ? (folders.find((f) => f.id === currentFolderId) ?? null) : null;
  const currentName = currentFolderId ? (breadcrumb[breadcrumb.length - 1]?.name ?? "this folder") : "the vault";
  const filtering = query.trim().length > 0;
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
    setFolderDialog({ mode: "new" });
  };

  const openRenameFolder = (folder: VaultFolder) => {
    setFolderName(folder.name);
    setFolderError(null);
    setFolderDialog({ mode: "rename", folder });
  };

  async function submitFolderDialog() {
    const name = folderName.trim();
    if (!folderDialog) return;
    if (!name) {
      setFolderError("A folder needs a name.");
      return;
    }
    setFolderBusy(true);
    setFolderError(null);
    try {
      if (folderDialog.mode === "rename") {
        const result = await renameVaultFolder({
          folderId: folderDialog.folder.id,
          name,
          expectedVersion: folderDialog.folder.version,
        });
        if (!result.ok) {
          setFolderError(result.error);
          return;
        }
        setFolderDialog(null);
        router.refresh();
        return;
      }
      const result = await createVaultFolder(name, currentFolderId);
      if (!result.ok) {
        setFolderError(result.error);
        return;
      }
      setFolderDialog(null);
      setFolderName("");
      // A new folder is only useful if it is visible: drop any search that
      // would hide it, then let the server list pick it up.
      setQuery("");
      setCreatedFolder(result.name);
    } catch {
      setFolderError(
        folderDialog.mode === "rename"
          ? "The folder could not be renamed. Try again."
          : "The folder could not be created. Try again.",
      );
    } finally {
      setFolderBusy(false);
    }
  }

  const selection: Selection = {
    ids: picked,
    active: picked.size > 0,
    toggle: (id) =>
      setPicked((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
  const pickedDocuments = documents.filter((doc) => picked.has(doc.id));
  const moveTargets = folderPaths(folders);

  function moveSelection(target: string) {
    const folderId = target === "root" ? null : target;
    setBulkError(null);
    setMoving(true);
    moveVaultDocuments({
      documents: pickedDocuments.map((doc) => ({ id: doc.id, version: doc.version })),
      folderId,
    })
      .then((result) => {
        if (!result.ok) {
          setBulkError(result.error);
          return;
        }
        setPicked(new Set());
      })
      .catch(() => setBulkError("The move did not reach Polymath. Try again."))
      .finally(() => {
        setMoving(false);
        router.refresh();
      });
  }

  function zettelizeSelection() {
    setBulkError(null);
    zettel.zettelize(
      pickedDocuments.map((doc) => ({ kind: "document" as const, id: doc.id })),
      () => setPicked(new Set()),
    );
  }

  // A document's own zettelize job, for the viewer's verb.
  const zettelBusyFor = (documentId: string) => {
    const subject = zettelJobSubject({ kind: "document", id: documentId });
    return zettelSurface.jobs.some((job) => job.subject === subject && !isSettled(job.status));
  };

  const showEverything = () => {
    setQuery("");
  };

  const upload = useCallback(
    async (file: File, folderPath: string | null) => {
      const key = `${file.name}-${randomId()}`;
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
          headers: { "Idempotency-Key": randomId() },
          body,
        });
        const payload = (await response.json().catch(() => null)) as {
          documentId?: string;
          fileStatus?: string;
          title?: string;
        } | null;
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
          setUploads((prev) =>
            prev.map((u) => (u.key === key ? { ...u, documentId: payload.documentId, phase: "Reading…" } : u)),
          );
        } else {
          setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, state: "done" } : u)));
        }
        router.refresh();
      } catch (cause) {
        const text =
          cause instanceof Error
            ? cause.message
            : `${file.name} could not be uploaded. Check the connection and try again.`;
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
  // The dependency is the joined key, not the memo array: the tick's own
  // setUploads would otherwise hand the memo a new identity every render and
  // restart the interval per tick, pacing fetches by network speed instead of
  // the 2 s cadence. A string compares by value, so only a membership change
  // (a row finishing, giving up, or a new upload) re-arms the effect.
  const pendingKey = useMemo(
    () =>
      uploads
        .filter((u) => u.state === "busy" && u.documentId && !u.gaveUp)
        .map((u) => u.documentId as string)
        .join(","),
    [uploads],
  );
  useEffect(() => {
    if (!pendingKey) return;
    const pollIds = pendingKey.split(",");
    const startedAt = Date.now();
    const POLL_MS = 2_000;
    const GIVE_UP_MS = 5 * 60_000;

    const tick = async () => {
      if (Date.now() - startedAt > GIVE_UP_MS) {
        // Ceiling reached: these rows say honestly that the vault will catch up
        // on its own, and the poller drops them (gaveUp) instead of spinning
        // forever. Surviving rows re-arm with a fresh window.
        setUploads((prev) => {
          if (!prev.some((u) => u.state === "busy" && u.documentId && pollIds.includes(u.documentId))) return prev;
          return prev.map((u) =>
            u.state === "busy" && u.documentId && pollIds.includes(u.documentId)
              ? { ...u, gaveUp: true, phase: "Still reading — the vault row will update on its own." }
              : u,
          );
        });
        return;
      }
      try {
        const response = await fetch(`/api/v1/documents/readiness?ids=${pollIds.join(",")}`);
        if (!response.ok) return; // transient; the next tick retries
        const body = (await response.json()) as {
          sources?: Array<{ documentId: string; readiness: SourceReadiness; detail: string | null }>;
        };
        const byId = new Map((body.sources ?? []).map((s) => [s.documentId, s]));
        setUploads((prev) => {
          // Write only when a row actually moved: returning prev here keeps
          // renders (and therefore the effect's key) untouched on quiet ticks.
          let changed = false;
          const next = prev.map((u) => {
            if (u.state !== "busy" || !u.documentId) return u;
            const source = byId.get(u.documentId);
            if (!source) return u;
            const { phase, terminal } = phaseForReadiness(source.readiness, source.detail);
            if (!terminal) {
              if (u.phase === phase) return u;
              changed = true;
              return { ...u, phase };
            }
            changed = true;
            return terminal === "done"
              ? { ...u, phase, state: "done" as const }
              : { ...u, phase, state: "error" as const };
          });
          return changed ? next : prev;
        });
      } catch {
        // The poller is a status read, not a mutation: a failed tick is silent
        // and the next interval retries. Swallowing here is the honest choice.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [pendingKey]);

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
        <div className="border-input bg-background focus-within:ring-ring relative w-full max-w-sm min-w-0 rounded-md border transition-shadow focus-within:ring-3">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files and folders"
            aria-label="Search files and folders"
            className="min-h-9 w-full bg-transparent pl-8 pr-3 text-body-dense outline-none"
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
            <motion.span
              animate={{ rotate: plusOpen ? 45 : 0 }}
              transition={motionTransition}
              className="grid place-items-center"
            >
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
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body-dense outline-none"
                >
                  <FolderPlus className="size-3.5" aria-hidden /> New folder
                </button>
                <div className="bg-border my-1 h-px" aria-hidden />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => fileInput.current?.click()}
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body-dense outline-none"
                >
                  <Plus className="size-3.5" aria-hidden /> Upload files
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => folderInput.current?.click()}
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body-dense outline-none"
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
        <nav aria-label="Breadcrumb" className="flex min-h-6 min-w-0 flex-1 items-center gap-1 text-body-dense">
          {breadcrumb.map((crumb, index) => (
            <span key={`${crumb.name}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden /> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="text-muted-foreground truncate underline-offset-4 hover:underline">
                  {crumb.name}
                </Link>
              ) : (
                <span className="truncate font-medium">{crumb.name}</span>
              )}
              {!crumb.href && currentFolder ? (
                <IconButton
                  label={`Rename ${currentFolder.name}`}
                  icon={<Pencil aria-hidden />}
                  onClick={() => openRenameFolder(currentFolder)}
                  className="size-6"
                />
              ) : null}
            </span>
          ))}
        </nav>

        <div role="group" aria-label="Review state" className="flex shrink-0 items-center gap-3 text-body-dense">
          <span className="text-muted-foreground">
            <span className="text-foreground tabular-nums">{counts.review}</span> need review
          </span>
          <span className="text-muted-foreground">
            <span className="text-foreground tabular-nums">{counts.unread}</span> not read
          </span>
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
              <X className="size-3.5" aria-hidden />
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
            className="border-ring bg-accent/40 text-accent-foreground pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed text-body-dense font-medium"
          >
            Drop to file into {currentName}. Folders keep their structure, reading starts on its own.
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Uploads in flight: partial stays partial, each row reports its own state. */}
      <AnimatePresence>
        {uploads.length > 0 ? (
          <motion.ul
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-1"
            aria-label="Uploading"
          >
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
                <span
                  className="min-w-0 truncate"
                  title={item.state === "error" ? (item.note ?? item.phase) : item.phase}
                >
                  {item.name}
                </span>
                <span className={cn("readout shrink-0", item.state === "error" && "text-destructive")}>
                  {item.state === "busy"
                    ? (item.phase ?? "Reading…")
                    : item.state === "done"
                      ? (item.phase ?? "Added")
                      : (item.phase ?? "Failed")}
                </span>
              </motion.li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>

      {zettelSurface.jobs.length > 0 ? (
        <section aria-label="Zettelize" className="border-border rounded-md border px-3 py-2.5 text-body-dense">
          <GenerationJobRows surface={zettelSurface} />
        </section>
      ) : null}

      {emptyVault ? (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="panel-empty flex flex-col items-center gap-2 rounded-md px-6 py-12 text-center transition-colors hover:bg-muted/30"
        >
          <span className="border-border text-muted-foreground grid size-10 place-items-center rounded-md border border-dashed">
            <Plus className="size-5" aria-hidden />
          </span>
          <span className="text-body-dense font-medium">Add your first document</span>
          <span className="text-muted-foreground max-w-sm text-xs">
            Choose files to upload. Polymath reads what arrives and proposes the fields. Nothing is filed until you file
            it.
          </span>
        </button>
      ) : noMatches && uploads.length === 0 ? (
        <div className="panel-empty flex flex-col items-center gap-2 rounded-md px-6 py-12 text-center">
          <p className="text-body-dense font-medium">
            {filtering ? "Nothing here matches" : `Nothing in ${currentName} yet`}
          </p>
          <p className="text-muted-foreground max-w-sm text-xs">
            {filtering ? "Clear the search to see everything here." : "Drop files here, or use New to add something."}
          </p>
          {filtering ? (
            <Button type="button" variant="outline" onClick={showEverything} className="mt-1">
              Show everything
            </Button>
          ) : null}
        </div>
      ) : view === "grid" ? (
        <GridView
          folders={visibleFolders}
          documents={visibleDocuments}
          onOpen={openViewer}
          selection={selection}
          onRenameFolder={openRenameFolder}
        />
      ) : (
        <ListView
          folders={visibleFolders}
          documents={visibleDocuments}
          onOpen={openViewer}
          selection={selection}
          onRenameFolder={openRenameFolder}
        />
      )}

      {picked.size > 0 || bulkError || zettel.error ? (
        <div
          role="toolbar"
          aria-label="Selected documents"
          className="border-border bg-card sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border p-2 shadow-[var(--shadow)]"
        >
          <span className="readout pl-1 text-body-dense">{picked.size} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Select
              aria-label="Move the selected documents to a folder"
              value=""
              disabled={moving || picked.size === 0}
              onChange={(event) => {
                if (event.target.value) moveSelection(event.target.value);
              }}
              className="w-48"
            >
              <option value="" disabled>
                {moving ? "Moving…" : "Move to folder"}
              </option>
              {currentFolderId ? <option value="root">Vault (top level)</option> : null}
              {moveTargets
                .filter((target) => target.id !== currentFolderId)
                .map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.path}
                  </option>
                ))}
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={
                zettel.pending || picked.size === 0 || !zettelProviderReady || picked.size > MAX_ZETTELIZE_SOURCES
              }
              title={
                !zettelProviderReady
                  ? zettelProviderReason
                  : picked.size > MAX_ZETTELIZE_SOURCES
                    ? `Zettelize up to ${MAX_ZETTELIZE_SOURCES} at a time.`
                    : "Makes ideas from each selected document in the background. They land in Ideas."
              }
              onClick={zettelizeSelection}
            >
              <Lightbulb aria-hidden /> Zettelize
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPicked(new Set());
                setBulkError(null);
              }}
            >
              Clear
            </Button>
          </div>
          {bulkError || zettel.error ? (
            <p role="alert" className="text-destructive w-full pl-1 text-xs">
              {bulkError ?? zettel.error}
            </p>
          ) : null}
        </div>
      ) : null}

      <AnimatePresence>
        {selected ? (
          <Viewer
            doc={selected}
            onClose={() => setSelectedId(null)}
            zettelize={{
              busy: zettel.pending || zettelBusyFor(selected.id),
              ready: zettelProviderReady,
              reason: zettelProviderReason,
              start: () => zettel.zettelize([{ kind: "document", id: selected.id }]),
            }}
          />
        ) : null}
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
        open={folderDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFolderDialog(null);
            setFolderError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{folderDialog?.mode === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
            <DialogDescription>
              {folderDialog?.mode === "rename"
                ? `Now called ${folderDialog.folder.name}.`
                : currentFolderId
                  ? `Inside ${currentName}.`
                  : "At the top of the vault."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitFolderDialog();
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
              <Button type="button" variant="outline" onClick={() => setFolderDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={folderBusy || !folderName.trim()}>
                {folderDialog?.mode === "rename"
                  ? folderBusy
                    ? "Renaming…"
                    : "Rename"
                  : folderBusy
                    ? "Creating…"
                    : "Create"}
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
function Viewer({
  doc,
  onClose,
  zettelize,
}: {
  doc: VaultDocument;
  onClose: () => void;
  zettelize: { busy: boolean; ready: boolean; reason: string; start: () => void };
}) {
  const [text, setText] = useState<string | null>(null);
  const [textState, setTextState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  // Under five thousand words the whole read fits through the clipboard, so
  // copy is offered; above it the text becomes a file the person saves.
  const wordCount = text ? text.trim().split(/\s+/).length : 0;
  const copyable = textState === "ready" && wordCount > 0 && wordCount <= 5000;

  async function copyText() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setRetryNote("The text could not be copied. Select it and copy by hand.");
    }
  }

  function downloadText() {
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${doc.title.replace(/[^\w\-. ]+/g, "_") || "document"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

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
          <p className="min-w-0 flex-1 truncate text-body-dense font-medium">{doc.title}</p>
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
          <IconButton
            label="Zettelize into Ideas"
            icon={<Lightbulb aria-hidden />}
            disabled={zettelize.busy || !zettelize.ready}
            disabledReason={!zettelize.ready ? zettelize.reason : "Making ideas from this document now."}
            onClick={zettelize.start}
          />
          {textState === "ready" && wordCount > 0 ? (
            <div className="flex shrink-0 items-center gap-0.5">
              {copyable ? (
                <button
                  type="button"
                  onClick={() => void copyText()}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs transition-colors"
                >
                  {copied ? <Check className="size-3.5" aria-hidden /> : <CopyIcon className="size-3.5" aria-hidden />}
                  {copied ? "Copied" : "Copy"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={downloadText}
                className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs transition-colors"
              >
                <Download className="size-3.5" aria-hidden /> Save
              </button>
            </div>
          ) : null}
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
              <div className="prose-reading p-4">
                <Markdown text={text ?? ""} />
              </div>
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
                  className="border-input hover:bg-muted inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-body-dense font-medium transition-colors active:scale-[0.98] disabled:opacity-60"
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
