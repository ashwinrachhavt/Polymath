import { and, asc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { companies, contacts } from "../crm/schema";
import type { LibraryRow } from "./library";
import { documentParties, documents } from "./schema";

/*
 * Library rows shaped for the Vault. listDocuments owns the query, keyset
 * cursor and state vocabulary; this adds what the Vault shows and the library
 * row does not carry (the source address and the parties), in two batched
 * reads per page, never one per row.
 */

const EXTRACTION_OF: Record<string, string | null> = {
  added: null,
  reading: "pending",
  could_not_read: "failed",
};

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

export async function toBrowserRows(auth: AuthContext, rows: LibraryRow[]): Promise<BrowserRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [sources, parties] = await Promise.all([
    db
      .select({ id: documents.id, sourceUrl: documents.sourceUrl })
      .from(documents)
      .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, ids))),
    db
      .select({
        documentId: documentParties.documentId,
        displayName: documentParties.displayName,
        contactName: contacts.fullName,
        companyName: companies.name,
      })
      .from(documentParties)
      .leftJoin(contacts, eq(contacts.id, documentParties.contactId))
      .leftJoin(companies, eq(companies.id, documentParties.companyId))
      .where(and(eq(documentParties.workspaceId, auth.workspaceId), inArray(documentParties.documentId, ids)))
      .orderBy(asc(documentParties.createdAt)),
  ]);
  const sourceUrl = new Map(sources.map((s) => [s.id, s.sourceUrl]));
  const names = new Map<string, string[]>();
  for (const p of parties) {
    names.set(p.documentId, [...(names.get(p.documentId) ?? []), p.contactName ?? p.companyName ?? p.displayName]);
  }
  return rows.map((r) => {
    const url = sourceUrl.get(r.id) ?? null;
    return {
      id: r.id,
      title: r.title,
      filename: r.filename,
      mimeType: r.mimeType,
      createdAt: r.createdAt.toISOString(),
      sourceUrl: url,
      kind: url ? ("web_page" as const) : ("file" as const),
      extractionStatus: r.state.key in EXTRACTION_OF ? EXTRACTION_OF[r.state.key]! : "succeeded",
      undecidedProposals: r.undecidedProposals,
      partyNames: names.get(r.id) ?? [],
      folderId: r.folderId,
      version: r.version,
      tags: r.tags,
    };
  });
}
