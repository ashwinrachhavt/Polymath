import type { AuthContext } from "@/domains/identity/resolve";
import { listDocuments, type LibraryFilters, type LibraryStateFilter } from "./library";
import { toBrowserRows } from "./file-rows";

/*
 * The vault's server read: documents in one folder (or the top level of the
 * library), shaped for the file browser. The folder tiles come from
 * listFolders; this owns the document rows only, reusing the library read and
 * the explorer's enrichment (source address, kind) rather than a second query
 * path.
 *
 * The root is a real folder view, not "the whole library": a document filed
 * in a folder belongs there, and showing it at the root as well would make
 * every folder feel like a copy. The library read spells that as "root".
 *
 * The review state comes from the library row's own state. listDocuments
 * evaluates status.ts in SQL, including the proposal pass, so the vault can
 * tell "filed" from "needs review" instead of calling every successfully-read
 * file "Fields not proposed". The pipeline's label is deliberately not carried
 * over: the vault has its own owner-facing words in vault-review.ts.
 */

export type VaultDocument = {
  id: string;
  title: string;
  filename: string | null;
  mimeType: string | null;
  kind: "web_page" | "file";
  /** The status.ts key, for the vault's review lens and filters. */
  reviewKey: LibraryStateFilter;
  undecidedProposals: number;
  sourceUrl: string | null;
  /** ISO date string; the vault renders it as "Oct 19". */
  updatedAt: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  docType: string | null;
  href: string;
};

export async function getVaultDocuments(auth: AuthContext, folderId: string | null): Promise<VaultDocument[]> {
  const filters: LibraryFilters = { folder: folderId ?? "root" };
  const page = await listDocuments(auth, { filters, sort: "recent", limit: 100 });
  const rows = await toBrowserRows(auth, page.rows);
  const byId = new Map(page.rows.map((row) => [row.id, row]));
  return rows.map((row) => {
    const source = byId.get(row.id)!;
    return {
      id: row.id,
      title: row.title,
      filename: row.filename,
      mimeType: row.mimeType,
      kind: row.kind,
      reviewKey: source.state.key,
      undecidedProposals: source.undecidedProposals,
      sourceUrl: row.sourceUrl,
      updatedAt: source.updatedAt.toISOString(),
      sizeBytes: source.sizeBytes,
      pageCount: source.pageCount,
      docType: source.docType,
      href: folderId
        ? `/alfred/knowledge?folder=${folderId}&doc=${row.id}`
        : `/alfred/knowledge?doc=${row.id}`,
    };
  });
}
