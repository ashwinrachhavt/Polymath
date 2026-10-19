"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  LayoutGrid,
  List,
  Search,
  Share2,
  Tag,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Readout } from "@/components/readout";
import {
  FOLDERS,
  flattenFolders,
  folderCounts,
  inFolder,
  kindLabel,
  matchesQuery,
  rangeIds,
  sortRows,
  tagCounts,
  statusLabel,
  type BrowserRow,
  type FolderId,
  type FolderNode,
  type SortKey,
} from "@/domains/knowledge/file-browser";
import { addTagAction, createFolderAction, moveDocumentsAction, removeTagAction, removeFolderAction, renameFolderAction } from "./actions";
import { invalidatePreview, PreviewPane } from "./preview-pane";
import { ShareDialog } from "./share-dialog";

type Upload = { key: string; name: string; state: "busy" | "done" | "error"; note?: string };
type ViewMode = "list" | "grid";

const VIEW_KEY = "axiom.files.view";
const VIEW_EVENT = "axiom:files-view";
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

const dateFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

function KindIcon({ row, className }: { row: BrowserRow; className?: string }) {
  if (row.kind === "web_page") return <Globe aria-hidden className={className} />;
  if (row.mimeType?.startsWith("image/")) return <FileImage aria-hidden className={className} />;
  return <FileText aria-hidden className={className} />;
}

function StatusBadge({ row }: { row: BrowserRow }) {
  const label = statusLabel(row);
  const variant = row.extractionStatus === "failed" ? "destructive" : row.undecidedProposals > 0 ? "default" : "outline";
  return <Badge variant={variant}>{label}</Badge>;
}

const DRAG_TYPE = "application/x-axiom-documents";

export function FileExplorer({
  initialRows,
  folders,
  truncated,
}: {
  initialRows: BrowserRow[];
  folders: FolderNode[];
  truncated: boolean;
}) {
  const router = useRouter();
  // The server re-renders after an upload or re-read; its rows are the truth.
  const rows = initialRows;
  const [folder, setFolder] = useState<FolderId>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const view = useSyncExternalStore(subscribeView, readView, () => "list" as ViewMode);
  const [rawSelected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newFolderIn, setNewFolderIn] = useState<{ parentId: string | null; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const chooseView = (next: ViewMode) => {
    window.localStorage.setItem(VIEW_KEY, next);
    window.dispatchEvent(new Event(VIEW_EVENT));
  };

  const counts = useMemo(() => folderCounts(rows), [rows]);
  const tree = useMemo(() => flattenFolders(folders), [folders]);
  const tags = useMemo(() => tagCounts(rows), [rows]);
  const activeFolder = folder.startsWith("folder:") ? (folders.find((f) => `folder:${f.id}` === folder) ?? null) : null;
  const visible = useMemo(
    () => sortRows(rows.filter((r) => inFolder(r, folder) && matchesQuery(r, query)), sort),
    [rows, folder, query, sort],
  );
  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);
  const activeRow = visible.find((r) => r.id === active) ?? null;

  // A filter that hides a row also drops it from the selection, so a bulk
  // action never touches rows the owner cannot see.
  const selected = useMemo(() => rawSelected.filter((id) => visibleIds.includes(id)), [rawSelected, visibleIds]);
  const selectedRows = rows.filter((r) => selected.includes(r.id));

  const toggle = useCallback(
    (id: string, shift: boolean) => {
      if (shift && anchor) {
        const range = rangeIds(visibleIds, anchor, id);
        setSelected((prev) => Array.from(new Set([...prev, ...range])));
      } else {
        setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
        setAnchor(id);
      }
    },
    [anchor, visibleIds],
  );

  async function uploadFiles(files: File[]) {
    const accepted = files.filter((f) => /\.(pdf|png|jpe?g)$/i.test(f.name));
    const skipped = files.length - accepted.length;
    if (skipped > 0) setNotice(`${skipped} file${skipped === 1 ? "" : "s"} skipped: only PDF, PNG and JPEG are read.`);
    for (const file of accepted) {
      const key = crypto.randomUUID();
      setUploads((u) => [{ key, name: file.name, state: "busy" }, ...u]);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("title", file.name.replace(/\.[^.]+$/, "") || file.name);
        const response = await fetch("/api/v1/files", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body,
        });
        const payload = (await response.json().catch(() => null)) as { fileStatus?: string; title?: string } | null;
        if (!response.ok) {
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "error", note: payload?.title ?? `Failed (${response.status})` } : x)));
        } else if (payload?.fileStatus === "quarantined") {
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "error", note: "Kept, but the type could not be identified." } : x)));
        } else {
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "done" } : x)));
          router.refresh();
        }
      } catch {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: "error", note: "Network error" } : x)));
      }
    }
  }

  async function rereadSelected() {
    const targets = selectedRows.filter((r) => r.extractionStatus === null || r.extractionStatus === "failed");
    if (targets.length === 0) {
      setNotice("Nothing selected needs reading.");
      return;
    }
    setNotice(`Reading ${targets.length} document${targets.length === 1 ? "" : "s"}…`);
    const results = await Promise.all(
      targets.map((r) => fetch(`/api/v1/documents/${r.id}/extract`, { method: "POST" }).then((res) => res.ok).catch(() => false)),
    );
    const failed = results.filter((ok) => !ok).length;
    setNotice(failed ? `${targets.length - failed} read, ${failed} could not be read.` : `${targets.length} read.`);
    router.refresh();
  }

  async function copyTitles() {
    await navigator.clipboard.writeText(selectedRows.map((r) => r.title).join("\n")).catch(() => undefined);
    setNotice(`Copied ${selectedRows.length} title${selectedRows.length === 1 ? "" : "s"}.`);
  }

  async function organise(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    const result = await fn();
    setNotice(result.ok ? done : result.error);
    if (result.ok) router.refresh();
    return result.ok;
  }

  function move(ids: string[], folderId: string | null) {
    const items = rows.filter((r) => ids.includes(r.id)).map((r) => ({ documentId: r.id, expectedVersion: r.version }));
    if (items.length === 0) return Promise.resolve(false);
    for (const item of items) invalidatePreview(item.documentId);
    return organise(() => moveDocumentsAction(items, folderId), folderId ? "Moved." : "Moved to Unfiled.");
  }

  async function submitNewFolder() {
    const draft = newFolderIn;
    if (!draft?.name.trim()) return setNewFolderIn(null);
    const result = await createFolderAction(draft.name, draft.parentId);
    if (result.ok) {
      setNewFolderIn(null);
      setFolder(`folder:${result.folderId}`);
      router.refresh();
    } else {
      setNotice(result.error);
    }
  }

  function startDrag(event: React.DragEvent, id: string) {
    const ids = selected.includes(id) ? selected : [id];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "move";
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.matches("input, select, textarea")) {
      if (event.key === "Escape") (target as HTMLInputElement).blur();
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    const idx = active ? visibleIds.indexOf(active) : -1;
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      const next = visibleIds[Math.min(idx + 1, visibleIds.length - 1)];
      if (next) setActive(next);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      const next = visibleIds[Math.max(idx - 1, 0)];
      if (next) setActive(next);
    } else if (event.key === " " && active) {
      event.preventDefault();
      toggle(active, event.shiftKey);
    } else if (event.key === "Enter" && active) {
      router.push(`/alfred/library/${active}`);
    } else if (event.key === "Escape") {
      setSelected([]);
      setActive(null);
    }
  }

  const allSelected = visible.length > 0 && visible.every((r) => selected.includes(r.id));

  return (
    <div
      className="relative flex min-h-[60dvh] flex-col md:flex-row"
      onKeyDown={onKeyDown}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void uploadFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging ? (
        <div
          role="status"
          className="border-ring bg-background/90 pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed"
        >
          <p className="font-display text-xl">Drop to add to your documents</p>
        </div>
      ) : null}

      <nav aria-label="Folders" className="border-border flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-60 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3">
        {FOLDERS.map((f) => (
          <button
            key={f.id}
            type="button"
            title={f.hint}
            aria-current={folder === f.id ? "page" : undefined}
            onClick={() => setFolder(f.id)}
            onDragOver={(e) => {
              if (f.id === "unfiled" && e.dataTransfer.types.includes(DRAG_TYPE)) {
                e.preventDefault();
                setDropTarget("unfiled");
              }
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              const raw = f.id === "unfiled" ? e.dataTransfer.getData(DRAG_TYPE) : "";
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(null);
              dragDepth.current = 0;
              setDragging(false);
              void move(JSON.parse(raw) as string[], null);
            }}
            className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap hover:bg-muted ${folder === f.id ? "bg-muted font-medium" : "text-muted-foreground"} ${dropTarget === f.id ? "ring-ring ring-2" : ""}`}
          >
            <span>{f.label}</span>
            <Readout className="text-xs text-muted-foreground">{counts[f.id]}</Readout>
          </button>
        ))}
        <div className="text-muted-foreground mt-3 hidden items-center justify-between px-2.5 text-xs md:flex">
          <span>My folders</span>
          <button type="button" aria-label="New folder" onClick={() => setNewFolderIn({ parentId: activeFolder?.id ?? null, name: "" })} className="hover:bg-muted rounded p-0.5">
            <FolderPlus aria-hidden className="size-3.5" />
          </button>
        </div>
        <button type="button" onClick={() => setNewFolderIn({ parentId: null, name: "" })} className="text-muted-foreground hover:bg-muted flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap md:hidden">
          <FolderPlus aria-hidden className="size-3.5" /> New folder
        </button>
        {newFolderIn ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewFolder();
            }}
          >
            <input
              autoFocus
              value={newFolderIn.name}
              onChange={(e) => setNewFolderIn({ ...newFolderIn, name: e.target.value })}
              onBlur={() => !newFolderIn.name.trim() && setNewFolderIn(null)}
              onKeyDown={(e) => e.key === "Escape" && setNewFolderIn(null)}
              maxLength={80}
              aria-label={newFolderIn.parentId ? "Subfolder name" : "Folder name"}
              placeholder={newFolderIn.parentId ? "Subfolder name" : "Folder name"}
              className="border-input bg-background focus-visible:ring-ring h-8 w-full min-w-32 rounded-md border px-2 text-[13px] outline-none focus-visible:ring-2"
            />
          </form>
        ) : null}
        {tree.map((f) => {
          const id = `folder:${f.id}`;
          return (
            <button
              key={f.id}
              type="button"
              aria-current={folder === id ? "page" : undefined}
              onClick={() => setFolder(id)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                  e.preventDefault();
                  setDropTarget(f.id);
                }
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData(DRAG_TYPE);
                if (!raw) return;
                e.preventDefault();
                e.stopPropagation();
                setDropTarget(null);
                dragDepth.current = 0;
                setDragging(false);
                void move(JSON.parse(raw) as string[], f.id);
              }}
              style={{ paddingLeft: `${0.625 + f.depth * 0.875}rem` }}
              className={`flex items-center justify-between gap-3 rounded-md py-1.5 pr-2.5 text-left text-[13px] whitespace-nowrap hover:bg-muted ${folder === id ? "bg-muted font-medium" : "text-muted-foreground"} ${dropTarget === f.id ? "ring-ring ring-2" : ""}`}
            >
              <span className="flex min-w-0 items-center gap-1.5"><Folder aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{f.name}</span></span>
              <Readout className="text-xs text-muted-foreground">{f.documentCount}</Readout>
            </button>
          );
        })}
        {tags.length > 0 ? (
          <>
            <p className="text-muted-foreground mt-3 hidden px-2.5 text-xs md:block">Tags</p>
            {tags.map((t) => (
              <button
                key={t.tag}
                type="button"
                aria-current={folder === `tag:${t.tag}` ? "page" : undefined}
                onClick={() => setFolder(`tag:${t.tag}`)}
                className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap hover:bg-muted ${folder === `tag:${t.tag}` ? "bg-muted font-medium" : "text-muted-foreground"}`}
              >
                <span className="flex min-w-0 items-center gap-1.5"><Tag aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{t.tag}</span></span>
                <Readout className="text-xs text-muted-foreground">{t.count}</Readout>
              </button>
            ))}
          </>
        ) : null}
        <p className="text-muted-foreground mt-3 hidden px-2.5 text-xs leading-relaxed md:block">
          Drag documents onto a folder to file them. Built-in views describe what a document is; folders are where you keep it.
        </p>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Documents">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-2.5 md:px-5">
          <label className="relative min-w-[12rem] flex-1">
            <span className="sr-only">Search documents</span>
            <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles, files, people  ( / )"
              className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border pr-2 pl-8 text-[13px] outline-none focus-visible:ring-2"
            />
          </label>
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by" className="w-36">
            <option value="recent">Newest first</option>
            <option value="name">Name</option>
            <option value="status">Needs review first</option>
          </Select>
          <div role="group" aria-label="View" className="border-input flex overflow-hidden rounded-md border">
            <button type="button" aria-pressed={view === "list"} aria-label="List view" onClick={() => chooseView("list")} className={`grid size-9 place-items-center ${view === "list" ? "bg-muted" : "hover:bg-muted"}`}>
              <List aria-hidden className="size-4" />
            </button>
            <button type="button" aria-pressed={view === "grid"} aria-label="Grid view" onClick={() => chooseView("grid")} className={`grid size-9 place-items-center ${view === "grid" ? "bg-muted" : "hover:bg-muted"}`}>
              <LayoutGrid aria-hidden className="size-4" />
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpeg,.jpg"
            className="sr-only"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void uploadFiles(files);
            }}
          />
          <Button type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload aria-hidden className="size-4" /> Upload
          </Button>
        </div>

        {activeFolder ? (
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[13px] md:px-5">
            {renaming === activeFolder.id ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = new FormData(e.currentTarget).get("name");
                  void organise(() => renameFolderAction(activeFolder.id, String(value), activeFolder.version), "Renamed.").then(() => setRenaming(null));
                }}
              >
                <input name="name" autoFocus defaultValue={activeFolder.name} maxLength={80} aria-label="Folder name" className="border-input bg-background h-8 rounded-md border px-2 text-[13px]" />
                <Button type="submit" size="sm">Save</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <span className="font-medium">{activeFolder.name}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(activeFolder.id)}>Rename</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setNewFolderIn({ parentId: activeFolder.id, name: "" })}>New subfolder</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (!window.confirm(`Remove the empty folder "${activeFolder.name}"? A folder with documents or subfolders cannot be removed.`)) return;
                    void organise(() => removeFolderAction(activeFolder.id, activeFolder.version), "Folder removed.").then((ok) => ok && setFolder("all"));
                  }}
                >
                  Remove folder
                </Button>
              </>
            )}
          </div>
        ) : null}

        {selected.length > 0 ? (
          <div role="toolbar" aria-label="Bulk actions" className="bg-muted/60 border-border flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[13px] md:px-5">
            <Readout>{selected.length} selected</Readout>
            <Button type="button" variant="outline" size="sm" onClick={() => void rereadSelected()}>Read again</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyTitles()}>Copy titles</Button>
            <Select
              aria-label="Move to folder"
              value=""
              className="w-40"
              onChange={(e) => {
                const value = e.target.value;
                if (value) void move(selected, value === "__unfiled" ? null : value);
              }}
            >
              <option value="">Move to…</option>
              <option value="__unfiled">Unfiled</option>
              {tree.map((f) => (
                <option key={f.id} value={f.id}>{`${"\u00a0\u00a0".repeat(f.depth)}${f.name}`}</option>
              ))}
            </Select>
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!tagDraft.trim()) return;
                for (const id of selected) invalidatePreview(id);
                void organise(() => addTagAction(selected, tagDraft), "Tagged.").then((ok) => ok && setTagDraft(""));
              }}
            >
              <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} maxLength={40} aria-label="Add a tag" placeholder="Add tag" className="border-input bg-background h-8 w-24 rounded-md border px-2 text-[13px]" />
              <Button type="submit" variant="outline" size="sm">Tag</Button>
            </form>
            <Button type="button" variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <Share2 aria-hidden className="size-3.5" /> Share
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button>
          </div>
        ) : null}

        {notice || uploads.length > 0 ? (
          <div aria-live="polite" className="border-border flex flex-col gap-1 border-b px-4 py-2 text-xs md:px-5">
            {notice ? (
              <p className="text-muted-foreground flex items-center justify-between">
                {notice}
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X aria-hidden className="size-3.5" /></button>
              </p>
            ) : null}
            {uploads.slice(0, 5).map((u) => (
              <p key={u.key} className={u.state === "error" ? "text-destructive" : "text-muted-foreground"}>
                {u.state === "busy" ? "Uploading" : u.state === "done" ? "Added" : "Could not add"} {u.name}
                {u.note ? ` - ${u.note}` : ""}
              </p>
            ))}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <p className="font-display text-xl">{rows.length === 0 ? "No documents yet" : "Nothing matches"}</p>
            <p className="text-muted-foreground max-w-sm text-[13px]">
              {rows.length === 0
                ? "Drop a PDF or image anywhere on this page. It is read, and its fields wait for your review."
                : "Clear the search or pick another folder."}
            </p>
          </div>
        ) : view === "list" ? (
          <table className="w-full text-[13px]">
            <thead className="text-muted-foreground text-xs">
              <tr className="border-border border-b">
                <th className="w-10 py-2 pl-4 md:pl-5">
                  <input
                    type="checkbox"
                    aria-label="Select all visible"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? [] : visibleIds)}
                  />
                </th>
                <th className="py-2 text-left font-normal">Name</th>
                <th className="hidden py-2 text-left font-normal md:table-cell">People</th>
                <th className="hidden py-2 text-left font-normal sm:table-cell">Type</th>
                <th className="py-2 text-left font-normal">Status</th>
                <th className="hidden py-2 pr-5 text-left font-normal lg:table-cell">Added</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.id}
                  draggable
                  onDragStart={(e) => startDrag(e, row.id)}
                  aria-selected={selected.includes(row.id)}
                  onClick={() => setActive(row.id)}
                  onDoubleClick={() => router.push(`/alfred/library/${row.id}`)}
                  className={`border-border cursor-default border-b hover:bg-muted/60 ${active === row.id ? "bg-muted" : ""}`}
                >
                  <td className="py-2 pl-4 md:pl-5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.title}`}
                      checked={selected.includes(row.id)}
                      onChange={() => undefined}
                      onClick={(e) => toggle(row.id, e.shiftKey)}
                    />
                  </td>
                  <td className="max-w-0 py-2 pr-3">
                    <span className="flex items-center gap-2">
                      <KindIcon row={row} className="text-muted-foreground size-4 shrink-0" />
                      <span className="truncate font-medium">{row.title}</span>
                    </span>
                  </td>
                  <td className="text-muted-foreground hidden max-w-[12rem] truncate py-2 pr-3 md:table-cell">{row.partyNames.slice(0, 2).join(", ") || "-"}</td>
                  <td className="text-muted-foreground hidden py-2 pr-3 sm:table-cell">{kindLabel(row)}</td>
                  <td className="py-2 pr-3"><StatusBadge row={row} /></td>
                  <td className="text-muted-foreground hidden py-2 pr-5 lg:table-cell"><Readout>{dateFmt.format(new Date(row.createdAt))}</Readout></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="grid grid-cols-2 gap-3 p-4 md:p-5 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((row) => (
              <li key={row.id}>
                <div
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => startDrag(e, row.id)}
                  aria-pressed={selected.includes(row.id)}
                  onClick={() => setActive(row.id)}
                  onDoubleClick={() => router.push(`/alfred/library/${row.id}`)}
                  className={`border-border hover:bg-muted/60 relative flex h-full flex-col gap-2 rounded-lg border p-3 ${active === row.id ? "bg-muted" : ""}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    className="absolute top-2 right-2"
                    checked={selected.includes(row.id)}
                    onChange={() => undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(row.id, e.shiftKey);
                    }}
                  />
                  <div className="bg-muted/70 grid h-20 place-items-center rounded-md">
                    <KindIcon row={row} className="text-muted-foreground size-7" />
                  </div>
                  <p className="truncate text-[13px] font-medium">{row.title}</p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-xs">{kindLabel(row)}</span>
                    <StatusBadge row={row} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {truncated ? (
          <p className="text-muted-foreground px-5 py-3 text-xs">Showing the newest 300. Search the Knowledge inbox for older documents.</p>
        ) : null}
        <p className="text-muted-foreground px-5 py-3 text-xs">
          Keys: / search, arrows move, space selects, enter opens. <Link href="/alfred/knowledge" className="underline-offset-4 hover:underline">Open the review inbox</Link>
        </p>
      </section>

      {activeRow ? <PreviewPane key={activeRow.id} row={activeRow} folders={tree} onMove={(id) => void move([activeRow.id], id)} onTag={(t) => { invalidatePreview(activeRow.id); return organise(() => addTagAction([activeRow.id], t), "Tagged."); }} onUntag={(t) => { invalidatePreview(activeRow.id); void organise(() => removeTagAction([activeRow.id], t), "Tag removed."); }} onClose={() => setActive(null)} onShare={() => setShareOpen(true)} /> : null}
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} rows={selectedRows.length > 0 ? selectedRows : activeRow ? [activeRow] : []} />
    </div>
  );
}
