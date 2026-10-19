/*
 * Pure browsing logic for the Files surface: smart folders, search, sort and
 * the kind label. No I/O, so the explorer stays a thin view and the rules are
 * unit-testable. A folder here is a saved view over canonical documents, never
 * a second copy: moving a document between folders is not a thing, because
 * membership is derived from what the document is.
 */

export type BrowserRow = {
  id: string;
  title: string;
  filename: string | null;
  mimeType: string | null;
  createdAt: string;
  sourceUrl: string | null;
  kind: "web_page" | "file";
  extractionStatus: string | null;
  undecidedProposals: number;
  partyNames: string[];
  /** The folder the document is filed in; null means it sits at the root (Unfiled). */
  folderId: string | null;
  /** The document's version, needed to file it with an optimistic-concurrency check. */
  version: number;
  tags: string[];
};

/** A built-in view id, `folder:<uuid>`, or `tag:<name>` for the owner's own. */
export type FolderId = string;
export type BuiltinFolderId = "all" | "files" | "pages" | "review" | "unread" | "failed" | "unfiled";

export type FolderNode = { id: string; parentId: string | null; name: string; version: number; documentCount: number };
export type FolderTreeItem = FolderNode & { depth: number };

/** Depth-first, name-ordered flattening of the folder tree for the rail. Orphans surface at the root. */
export function flattenFolders(folders: FolderNode[]): FolderTreeItem[] {
  const ids = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, FolderNode[]>();
  for (const f of folders) {
    const key = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    children.set(key, [...(children.get(key) ?? []), f]);
  }
  const out: FolderTreeItem[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    const kids = (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    for (const kid of kids) {
      if (seen.has(kid.id)) continue;
      out.push({ ...kid, depth });
      walk(kid.id, depth + 1, new Set([...seen, kid.id]));
    }
  };
  walk(null, 0, new Set());
  return out;
}

export const FOLDERS: Array<{ id: BuiltinFolderId; label: string; hint: string }> = [
  { id: "all", label: "All documents", hint: "Everything in the workspace" },
  { id: "files", label: "Uploaded files", hint: "PDFs and images you added" },
  { id: "pages", label: "Saved pages", hint: "Captured from the web" },
  { id: "review", label: "Needs review", hint: "Proposals waiting for a decision" },
  { id: "unread", label: "Not read yet", hint: "No extraction has run" },
  { id: "failed", label: "Failed to read", hint: "Extraction failed" },
  { id: "unfiled", label: "Unfiled", hint: "Not in any folder" },
];

export function inFolder(row: BrowserRow, folder: FolderId): boolean {
  if (folder.startsWith("folder:")) return row.folderId === folder.slice(7);
  if (folder.startsWith("tag:")) return row.tags.includes(folder.slice(4));
  switch (folder as BuiltinFolderId) {
    case "all":
      return true;
    case "files":
      return row.kind === "file";
    case "pages":
      return row.kind === "web_page";
    case "review":
      return row.undecidedProposals > 0;
    case "unread":
      return row.extractionStatus === null;
    case "failed":
      return row.extractionStatus === "failed";
    case "unfiled":
      return row.folderId === null;
    default:
      return false;
  }
}

export function folderCounts(rows: BrowserRow[]): Record<BuiltinFolderId, number> {
  const counts = {} as Record<BuiltinFolderId, number>;
  for (const folder of FOLDERS) counts[folder.id] = rows.filter((r) => inFolder(r, folder.id)).length;
  return counts;
}

export function matchesQuery(row: BrowserRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [row.title, row.filename ?? "", row.sourceUrl ?? "", ...row.partyNames, ...row.tags].join("\n").toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export type SortKey = "recent" | "name" | "status";

export function sortRows(rows: BrowserRow[], key: SortKey): BrowserRow[] {
  const copy = [...rows];
  if (key === "name") return copy.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
  if (key === "status")
    return copy.sort((a, b) => b.undecidedProposals - a.undecidedProposals || a.title.localeCompare(b.title));
  return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function kindLabel(row: Pick<BrowserRow, "kind" | "mimeType">): string {
  if (row.kind === "web_page") return "Web page";
  if (row.mimeType === "application/pdf") return "PDF";
  if (row.mimeType?.startsWith("image/")) return "Image";
  return "File";
}

export function statusLabel(row: Pick<BrowserRow, "extractionStatus" | "undecidedProposals">): string {
  if (row.undecidedProposals > 0) return `${row.undecidedProposals} to review`;
  switch (row.extractionStatus) {
    case null:
      return "Not read";
    case "pending":
      return "Reading";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return "Read";
  }
}

/** Selection helper for shift-click ranges over the visible order. */
export function rangeIds(visible: string[], anchor: string, target: string): string[] {
  const a = visible.indexOf(anchor);
  const b = visible.indexOf(target);
  if (a < 0 || b < 0) return [target];
  const [from, to] = a < b ? [a, b] : [b, a];
  return visible.slice(from, to + 1);
}

/** Distinct tags across the rows with how many documents carry each, most used first. */
export function tagCounts(rows: BrowserRow[]): Array<{ tag: string; count: number }> {
  const by = new Map<string, number>();
  for (const row of rows) for (const tag of row.tags) by.set(tag, (by.get(tag) ?? 0) + 1);
  return [...by].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
