import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { documentFolders, documentPlacements, documents, documentTags } from "./schema";

/*
 * Folders and tags over documents. Organisation only: nothing here writes to a
 * document, its file or its extraction. Every read and write is scoped to the
 * caller's workspace, so a foreign id is "not found". Each change commits with
 * its audit row, and every mutation is idempotent: moving a document where it
 * already is, or adding a tag it already has, changes nothing and records
 * nothing.
 */

export class FolderError extends Error {
  constructor(
    readonly code: "invalid" | "duplicate" | "not_found" | "stale",
    message: string,
  ) {
    super(message);
  }
}

export const MAX_BATCH = 200;

export function normalizeFolderName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length < 1 || clean.length > 80) throw new FolderError("invalid", "A folder name is 1 to 80 characters.");
  return clean;
}

export function normalizeTag(tag: string): string {
  const clean = tag.replace(/\s+/g, " ").trim().toLowerCase().replace(/^#/, "");
  if (clean.length < 1 || clean.length > 40) throw new FolderError("invalid", "A tag is 1 to 40 characters.");
  return clean;
}

/** Drizzle wraps the driver error as `cause`; walk the chain to find the Postgres code. */
function isUniqueViolation(cause: unknown): boolean {
  for (let e: unknown = cause, i = 0; e && typeof e === "object" && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

export type FolderRow = { id: string; name: string; version: number; documentCount: number };

export async function listFolders(auth: AuthContext): Promise<FolderRow[]> {
  const folders = await db
    .select({ id: documentFolders.id, name: documentFolders.name, version: documentFolders.version })
    .from(documentFolders)
    .where(and(eq(documentFolders.workspaceId, auth.workspaceId), isNull(documentFolders.archivedAt)))
    .orderBy(asc(sql`lower(${documentFolders.name})`));
  if (folders.length === 0) return [];
  const counts = await db
    .select({ folderId: documentPlacements.folderId, n: count() })
    .from(documentPlacements)
    .innerJoin(documents, eq(documents.id, documentPlacements.documentId))
    .where(
      and(
        eq(documentPlacements.workspaceId, auth.workspaceId),
        inArray(documentPlacements.folderId, folders.map((f) => f.id)),
        isNull(documents.archivedAt),
      ),
    )
    .groupBy(documentPlacements.folderId);
  const by = new Map(counts.map((c) => [c.folderId, Number(c.n)]));
  return folders.map((f) => ({ ...f, documentCount: by.get(f.id) ?? 0 }));
}

export async function createFolder(auth: AuthContext, input: { name: string }) {
  const name = normalizeFolderName(input.name);
  try {
    return await withTransaction(async (tx) => {
      const [folder] = await tx
        .insert(documentFolders)
        .values({ workspaceId: auth.workspaceId, name, createdBy: auth.userId, updatedBy: auth.userId })
        .returning();
      await recordAudit(
        auth,
        { action: "document_folder.created", subjectType: "document_folder", subjectId: folder!.id, summary: `Created folder "${name}"` },
        tx,
      );
      return folder!;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) throw new FolderError("duplicate", `A folder named "${name}" already exists.`);
    throw cause;
  }
}

export async function renameFolder(auth: AuthContext, input: { folderId: string; name: string; expectedVersion: number }) {
  const name = normalizeFolderName(input.name);
  try {
    return await withTransaction(async (tx) => {
      const [folder] = await tx
        .update(documentFolders)
        .set({ name, updatedAt: sql`now()`, updatedBy: auth.userId, version: sql`${documentFolders.version} + 1` })
        .where(
          and(
            eq(documentFolders.id, input.folderId),
            eq(documentFolders.workspaceId, auth.workspaceId),
            isNull(documentFolders.archivedAt),
            eq(documentFolders.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!folder) throw new FolderError("stale", "That folder changed or is gone. Reload to see the current state.");
      await recordAudit(
        auth,
        { action: "document_folder.renamed", subjectType: "document_folder", subjectId: folder.id, summary: `Renamed folder to "${name}"` },
        tx,
      );
      return folder;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) throw new FolderError("duplicate", `A folder named "${name}" already exists.`);
    throw cause;
  }
}

/** Hides the folder. Its documents are untouched and read as Unfiled everywhere. */
export async function archiveFolder(auth: AuthContext, input: { folderId: string; expectedVersion: number }) {
  return withTransaction(async (tx) => {
    const [folder] = await tx
      .update(documentFolders)
      .set({ archivedAt: sql`now()`, updatedAt: sql`now()`, updatedBy: auth.userId, version: sql`${documentFolders.version} + 1` })
      .where(
        and(
          eq(documentFolders.id, input.folderId),
          eq(documentFolders.workspaceId, auth.workspaceId),
          isNull(documentFolders.archivedAt),
          eq(documentFolders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!folder) throw new FolderError("stale", "That folder changed or is gone. Reload to see the current state.");
    await tx.delete(documentPlacements).where(and(eq(documentPlacements.folderId, folder.id), eq(documentPlacements.workspaceId, auth.workspaceId)));
    await recordAudit(
      auth,
      { action: "document_folder.archived", subjectType: "document_folder", subjectId: folder.id, summary: `Removed folder "${folder.name}" (documents kept)` },
      tx,
    );
    return folder;
  });
}

async function ownedDocumentIds(tx: TxDrizzle, auth: AuthContext, ids: string[]) {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0 || unique.length > MAX_BATCH) throw new FolderError("invalid", `Choose 1 to ${MAX_BATCH} documents.`);
  const found = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, unique)));
  if (found.length !== unique.length) throw new FolderError("not_found", "One of those documents is not in this workspace.");
  return unique;
}

/** Moves documents into a folder, or to Unfiled when folderId is null. Returns how many actually changed. */
export async function moveDocuments(auth: AuthContext, input: { documentIds: string[]; folderId: string | null }) {
  return withTransaction(async (tx) => {
    const ids = await ownedDocumentIds(tx, auth, input.documentIds);
    let folderName: string | null = null;
    if (input.folderId) {
      const [folder] = await tx
        .select({ id: documentFolders.id, name: documentFolders.name })
        .from(documentFolders)
        .where(and(eq(documentFolders.id, input.folderId), eq(documentFolders.workspaceId, auth.workspaceId), isNull(documentFolders.archivedAt)));
      if (!folder) throw new FolderError("not_found", "That folder is not in this workspace.");
      folderName = folder.name;
    }
    const current = await tx
      .select({ documentId: documentPlacements.documentId, folderId: documentPlacements.folderId })
      .from(documentPlacements)
      .where(and(eq(documentPlacements.workspaceId, auth.workspaceId), inArray(documentPlacements.documentId, ids)));
    const at = new Map(current.map((c) => [c.documentId, c.folderId]));
    const changing = ids.filter((id) => (at.get(id) ?? null) !== input.folderId);
    if (changing.length === 0) return { moved: 0 };

    if (input.folderId === null) {
      await tx.delete(documentPlacements).where(and(eq(documentPlacements.workspaceId, auth.workspaceId), inArray(documentPlacements.documentId, changing)));
    } else {
      await tx
        .insert(documentPlacements)
        .values(changing.map((documentId) => ({ workspaceId: auth.workspaceId, documentId, folderId: input.folderId!, createdBy: auth.userId })))
        .onConflictDoUpdate({ target: documentPlacements.documentId, set: { folderId: input.folderId } });
    }
    for (const documentId of changing) {
      await recordAudit(
        auth,
        {
          action: "document.moved",
          subjectType: "document",
          subjectId: documentId,
          summary: folderName ? `Moved to folder "${folderName}"` : "Moved to Unfiled",
        },
        tx,
      );
    }
    return { moved: changing.length };
  });
}

export async function addTag(auth: AuthContext, input: { documentIds: string[]; tag: string }) {
  const tag = normalizeTag(input.tag);
  return withTransaction(async (tx) => {
    const ids = await ownedDocumentIds(tx, auth, input.documentIds);
    const added = await tx
      .insert(documentTags)
      .values(ids.map((documentId) => ({ workspaceId: auth.workspaceId, documentId, tag, createdBy: auth.userId })))
      .onConflictDoNothing()
      .returning({ documentId: documentTags.documentId });
    for (const row of added) {
      await recordAudit(auth, { action: "document.tagged", subjectType: "document", subjectId: row.documentId, summary: `Added tag "${tag}"` }, tx);
    }
    return { added: added.length };
  });
}

export async function removeTag(auth: AuthContext, input: { documentIds: string[]; tag: string }) {
  const tag = normalizeTag(input.tag);
  return withTransaction(async (tx) => {
    const ids = await ownedDocumentIds(tx, auth, input.documentIds);
    const removed = await tx
      .delete(documentTags)
      .where(and(eq(documentTags.workspaceId, auth.workspaceId), eq(documentTags.tag, tag), inArray(documentTags.documentId, ids)))
      .returning({ documentId: documentTags.documentId });
    for (const row of removed) {
      await recordAudit(auth, { action: "document.untagged", subjectType: "document", subjectId: row.documentId, summary: `Removed tag "${tag}"` }, tx);
    }
    return { removed: removed.length };
  });
}

export type Organisation = {
  folderByDocument: Map<string, string>;
  tagsByDocument: Map<string, string[]>;
};

/** Placements and tags for a page of documents: two queries, never one per row. */
export async function getOrganisation(auth: AuthContext, documentIds: string[]): Promise<Organisation> {
  const folderByDocument = new Map<string, string>();
  const tagsByDocument = new Map<string, string[]>();
  if (documentIds.length === 0) return { folderByDocument, tagsByDocument };
  const [placements, tags] = await Promise.all([
    db
      .select({ documentId: documentPlacements.documentId, folderId: documentPlacements.folderId })
      .from(documentPlacements)
      .where(and(eq(documentPlacements.workspaceId, auth.workspaceId), inArray(documentPlacements.documentId, documentIds))),
    db
      .select({ documentId: documentTags.documentId, tag: documentTags.tag })
      .from(documentTags)
      .where(and(eq(documentTags.workspaceId, auth.workspaceId), inArray(documentTags.documentId, documentIds)))
      .orderBy(asc(documentTags.tag)),
  ]);
  for (const p of placements) folderByDocument.set(p.documentId, p.folderId);
  for (const t of tags) tagsByDocument.set(t.documentId, [...(tagsByDocument.get(t.documentId) ?? []), t.tag]);
  return { folderByDocument, tagsByDocument };
}
