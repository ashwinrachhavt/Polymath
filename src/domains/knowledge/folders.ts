import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { type TxDrizzle, withTransaction } from "@/lib/db-transaction";
import { documentFolderEvents, documentFolders, documents } from "./schema";

/*
 * The folder tree behind the Box-feel library. A folder is a name plus a
 * parent; the root is "no folder". Every mutation is version-checked and
 * audited, a move is a folder event rather than a document edit, and nothing
 * here deletes: archiving is blocked while a folder still holds live
 * documents or subfolders, so filing is never undone silently.
 */

export class FolderError extends Error {
  constructor(
    readonly code: "not_found" | "stale_write" | "not_empty" | "cycle" | "name_taken" | "invalid_name",
    message: string,
  ) {
    super(message);
  }
}

const liveFolder = (auth: AuthContext, id: string) =>
  and(
    eq(documentFolders.id, id),
    eq(documentFolders.workspaceId, auth.workspaceId),
    isNull(documentFolders.archivedAt),
  );

/** A folder name is trimmed and non-empty; the uniqueness rule lives on the table. */
export function validateFolderName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new FolderError("invalid_name", "A folder needs a name.");
  if (name.length > 120) throw new FolderError("invalid_name", "Folder names stay under 120 characters.");
  return name;
}

/**
 * True when moving `folderId` under `ancestorIds` would close a loop. The
 * caller passes the target parent's ancestor chain (target first); a folder
 * may never become its own descendant.
 */
export function wouldCreateCycle(folderId: string, ancestorIds: string[]): boolean {
  return ancestorIds.includes(folderId);
}

/** The live ancestor chain of a folder, parent first, bounded so a corrupt tree cannot loop forever. */
async function ancestorIdsOf(folderId: string | null, executor: TxDrizzle | typeof db = db): Promise<string[]> {
  const chain: string[] = [];
  let current = folderId;
  for (let depth = 0; current && depth < 100; depth += 1) {
    chain.push(current);
    const [row] = await executor
      .select({ parentId: documentFolders.parentId })
      .from(documentFolders)
      .where(eq(documentFolders.id, current))
      .limit(1);
    current = row?.parentId ?? null;
  }
  return chain;
}

export async function createFolder(auth: AuthContext, input: { name: string; parentId?: string | null }) {
  const name = validateFolderName(input.name);
  return withTransaction(async (tx) => {
    if (input.parentId) {
      const [parent] = await tx
        .select({ id: documentFolders.id })
        .from(documentFolders)
        .where(liveFolder(auth, input.parentId))
        .limit(1);
      if (!parent) throw new FolderError("not_found", "That parent folder is not available.");
    }
    const [folder] = await tx
      .insert(documentFolders)
      .values({ workspaceId: auth.workspaceId, parentId: input.parentId ?? null, name, createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    if (!folder) throw new FolderError("name_taken", "A folder with that name already lives here.");
    await recordAudit(
      auth,
      { action: "document_folder.created", subjectType: "document_folder", subjectId: folder.id, summary: `Created folder "${name}"` },
      tx,
    );
    return folder;
  });
}

export async function renameFolder(auth: AuthContext, input: { folderId: string; name: string; expectedVersion: number }) {
  const name = validateFolderName(input.name);
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(documentFolders)
      .set({ name, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documentFolders.version} + 1` })
      .where(and(liveFolder(auth, input.folderId), eq(documentFolders.version, input.expectedVersion)))
      .returning();
    if (!row) throw new FolderError("stale_write", "That folder changed or is gone. Reload to see the current state.");
    await recordAudit(
      auth,
      { action: "document_folder.renamed", subjectType: "document_folder", subjectId: row.id, summary: `Renamed folder to "${name}"` },
      tx,
    );
    return row;
  });
}

export async function moveFolder(auth: AuthContext, input: { folderId: string; parentId: string | null; expectedVersion: number }) {
  return withTransaction(async (tx) => {
    const [folder] = await tx.select().from(documentFolders).where(liveFolder(auth, input.folderId)).limit(1);
    if (!folder) throw new FolderError("not_found", "That folder is not available.");
    if (input.parentId) {
      if (input.parentId === input.folderId) {
        throw new FolderError("cycle", "A folder cannot be moved into itself.");
      }
      const [parent] = await tx.select().from(documentFolders).where(liveFolder(auth, input.parentId)).limit(1);
      if (!parent) throw new FolderError("not_found", "That parent folder is not available.");
      const chain = await ancestorIdsOf(input.parentId, tx);
      if (wouldCreateCycle(input.folderId, [input.parentId, ...chain])) {
        throw new FolderError("cycle", "A folder cannot be moved into its own descendant.");
      }
    }
    const [row] = await tx
      .update(documentFolders)
      .set({ parentId: input.parentId, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documentFolders.version} + 1` })
      .where(and(liveFolder(auth, input.folderId), eq(documentFolders.version, input.expectedVersion)))
      .returning();
    if (!row) throw new FolderError("stale_write", "That folder changed or is gone. Reload to see the current state.");
    await recordAudit(
      auth,
      { action: "document_folder.moved", subjectType: "document_folder", subjectId: row.id, summary: `Moved folder "${row.name}"` },
      tx,
    );
    return row;
  });
}

/**
 * Archive an empty folder. "Empty" is live documents and live subfolders; an
 * archived subfolder stays put, so an archived parent never resurrects a
 * live one. The block is the honest answer - unfiled documents would be a
 * silent change, and silent changes are the thing this engine refuses.
 */
export async function archiveFolder(auth: AuthContext, input: { folderId: string; expectedVersion: number }) {
  return withTransaction(async (tx) => {
    const [folder] = await tx.select().from(documentFolders).where(liveFolder(auth, input.folderId)).limit(1);
    if (!folder) throw new FolderError("not_found", "That folder is not available.");
    const [liveSubfolder] = await tx
      .select({ id: documentFolders.id })
      .from(documentFolders)
      .where(and(eq(documentFolders.parentId, input.folderId), isNull(documentFolders.archivedAt)))
      .limit(1);
    if (liveSubfolder) throw new FolderError("not_empty", "That folder still has subfolders. Move or archive them first.");
    const [liveDocument] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.folderId, input.folderId), isNull(documents.archivedAt)))
      .limit(1);
    if (liveDocument) throw new FolderError("not_empty", "That folder still has documents. Move them out first.");
    const [row] = await tx
      .update(documentFolders)
      .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documentFolders.version} + 1` })
      .where(and(liveFolder(auth, input.folderId), eq(documentFolders.version, input.expectedVersion)))
      .returning();
    if (!row) throw new FolderError("stale_write", "That folder changed or is gone. Reload to see the current state.");
    await recordAudit(
      auth,
      { action: "document_folder.archived", subjectType: "document_folder", subjectId: row.id, summary: `Archived folder "${row.name}"` },
      tx,
    );
    return row;
  });
}

/**
 * File a document into a folder (or back to the root with null). Version-
 * checked on the document; the move is written to document_folder_events in
 * the same transaction, so the activity feed always knows what happened.
 */
export async function setDocumentFolder(
  auth: AuthContext,
  input: { documentId: string; folderId: string | null; expectedVersion: number },
) {
  return withTransaction(async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id, title: documents.title, folderId: documents.folderId })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)))
      .limit(1);
    if (!doc) throw new FolderError("not_found", "That document is not available.");
    if (doc.folderId === input.folderId) return doc;
    if (input.folderId) {
      const [folder] = await tx.select({ id: documentFolders.id }).from(documentFolders).where(liveFolder(auth, input.folderId)).limit(1);
      if (!folder) throw new FolderError("not_found", "That folder is not available.");
    }
    const [row] = await tx
      .update(documents)
      .set({ folderId: input.folderId, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documents.version} + 1` })
      .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), eq(documents.version, input.expectedVersion)))
      .returning();
    if (!row) throw new FolderError("stale_write", "That document changed or is gone. Reload to see the current state.");
    await tx.insert(documentFolderEvents).values({
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      fromFolderId: doc.folderId,
      toFolderId: input.folderId,
      createdBy: auth.userId,
    });
    return row;
  });
}
