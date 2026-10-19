"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  FileImage,
  FileText,
  Globe,
  LayoutGrid,
  List,
  Search,
  Share2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Readout } from "@/components/readout";
import {
  FOLDERS,
  folderCounts,
  inFolder,
  kindLabel,
  matchesQuery,
  rangeIds,
  sortRows,
  statusLabel,
  type BrowserRow,
  type FolderId,
  type SortKey,
} from "@/domains/knowledge/file-browser";
import { PreviewPane } from "./preview-pane";
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

export function FileExplorer({ initialRows, truncated }: { initialRows: BrowserRow[]; truncated: boolean }) {
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
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const chooseView = (next: ViewMode) => {
    window.localStorage.setItem(VIEW_KEY, next);
    window.dispatchEvent(new Event(VIEW_EVENT));
  };

  const counts = useMemo(() => folderCounts(rows), [rows]);
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

      <nav aria-label="Folders" className="border-border flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-56 md:flex-col md:border-r md:border-b-0 md:p-3">
        {FOLDERS.map((f) => (
          <button
            key={f.id}
            type="button"
            title={f.hint}
            aria-current={folder === f.id ? "page" : undefined}
            onClick={() => setFolder(f.id)}
            className={`flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap hover:bg-muted ${folder === f.id ? "bg-muted font-medium" : "text-muted-foreground"}`}
          >
            <span>{f.label}</span>
            <Readout className="text-xs text-muted-foreground">{counts[f.id]}</Readout>
          </button>
        ))}
        <p className="text-muted-foreground mt-3 hidden px-2.5 text-xs leading-relaxed md:block">
          Folders are views. A document sits in every folder that describes it, so nothing is ever filed twice.
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

        {selected.length > 0 ? (
          <div role="toolbar" aria-label="Bulk actions" className="bg-muted/60 border-border flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[13px] md:px-5">
            <Readout>{selected.length} selected</Readout>
            <Button type="button" variant="outline" size="sm" onClick={() => void rereadSelected()}>Read again</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyTitles()}>Copy titles</Button>
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

      {activeRow ? <PreviewPane key={activeRow.id} row={activeRow} onClose={() => setActive(null)} onShare={() => setShareOpen(true)} /> : null}
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} rows={selectedRows.length > 0 ? selectedRows : activeRow ? [activeRow] : []} />
    </div>
  );
}
