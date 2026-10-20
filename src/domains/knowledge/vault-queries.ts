import type { AuthContext } from "@/domains/identity/resolve";
import { listDocuments, type LibraryFilters } from "./library";
import { toBrowserRows } from "./file-rows";
import { documentStatus } from "./status";

/*
 * The vault's server read: documents in one folder (or the whole library),
 * shaped for the Finder view. The folder tiles come from listFolders; this
 * owns the document rows only, reusing the library read and the explorer's
 * enrichment (source address, parties, kind) rather than a second query path.
 */

export type VaultDocument = {
  id: string;
  title: string;
  filename: string | null;
  mimeType: string | null;
  kind: "web_page" | "file";
  status: { label: string; tone: "neutral" | "progress" | "attention" | "done" | "error" };
  sourceUrl: string | null;
  updatedAt: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  docType: string | null;
  href: string;
};

export async function getVaultDocuments(auth: AuthContext, folderId: string | null): Promise<VaultDocument[]> {
  const filters: LibraryFilters = {};
  if (folderId) filters.folder = folderId;
  const page = await listDocuments(auth, { filters, sort: "recent", limit: 100 });
  const rows = await toBrowserRows(auth, page.rows);
  const now = new Date();
  const byId = new Map(page.rows.map((row) => [row.id, row]));
  return rows.map((row) => {
    const source = byId.get(row.id)!;
    const status = documentStatus(
      row.extractionStatus === null ? null : { status: row.extractionStatus, createdAt: null },
      row.undecidedProposals,
      now,
    );
    return {
      id: row.id,
      title: row.title,
      filename: row.filename,
      mimeType: row.mimeType,
      kind: row.kind,
      status: { label: status.label, tone: status.tone },
      sourceUrl: row.sourceUrl,
      updatedAt: source.updatedAt.toISOString(),
      sizeBytes: source.sizeBytes,
      pageCount: source.pageCount,
      docType: source.docType,
      href: `/alfred/knowledge?doc=${row.id}`,
    };
  });
}
