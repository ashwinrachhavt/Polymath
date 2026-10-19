import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { type TxDrizzle, withTransaction } from "@/lib/db-transaction";
import { documentExtractions, documents } from "./schema";

/*
 * Version restore (ASH-108 §15E): which extraction version a document reads
 * as. Every "latest extraction" read in the domain goes through
 * currentExtractionSql / getCurrentExtraction, so a restore changes what the
 * library, review, reading and retrieval surfaces show - one definition, no
 * drift. The pointer is only ever aimed at a succeeded row, and creating a
 * new extraction version clears it: a re-read is fresher evidence, and a
 * pin that outlived it would silently answer from stale text.
 */

export class VersionRestoreError extends Error {
  constructor(
    readonly code: "not_found" | "stale_write" | "not_succeeded",
    message: string,
  ) {
    super(message);
  }
}

/*
 * The current extraction's column as a SQL expression over documents. The
 * restore pointer wins; otherwise the newest extraction row, which is the
 * behavior every document had before restores existed.
 */
export const currentExtractionSql = (column: "id" | "status" | "proposal_status" | "content_hash" | "text" | "created_at") => sql`
  coalesce(
    (select ${sql.raw(`dea.${column}::text`)} from document_extractions dea where dea.id = ${documents.activeExtractionId}),
    (select ${sql.raw(`de.${column}::text`)} from document_extractions de
     where de.document_id = ${documents.id}
     order by de.created_at desc limit 1)
  )`;

/**
 * The current extraction row's id as raw SQL, for eq() comparisons inside
 * drizzle .where() clauses (kept as uuid, unlike currentExtractionSql's text
 * cast). The subquery joins documents so it can read the restore pin.
 */
export function currentExtractionIdSubquery() {
  return sql`
    coalesce(
      (select dea.id from document_extractions dea where dea.id = ${documents.activeExtractionId}),
      (select de.id from document_extractions de
       where de.document_id = ${documents.id}
       order by de.created_at desc limit 1)
    )`;
}

/** The current extraction row for one document, or null when it has never been read. */
export async function getCurrentExtraction(auth: AuthContext, input: { documentId: string }) {
  const [doc] = await db
    .select({ id: documents.id, activeExtractionId: documents.activeExtractionId })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return null;
  if (doc.activeExtractionId) {
    const [pinned] = await db
      .select()
      .from(documentExtractions)
      .where(eq(documentExtractions.id, doc.activeExtractionId))
      .limit(1);
    if (pinned) return pinned;
  }
  const [latest] = await db
    .select()
    .from(documentExtractions)
    .where(eq(documentExtractions.documentId, doc.id))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  return latest ?? null;
}

/**
 * True when a version can be restored to: it belongs to the document and
 * succeeded. A failed or pending read is never a restore target - the
 * library would show "Could not read" about bytes that were fine.
 */
export function canRestore(extraction: { documentId: string; status: string }, documentId: string): boolean {
  return extraction.documentId === documentId && extraction.status === "succeeded";
}

/**
 * Point the document at one of its succeeded extractions. Version-checked on
 * the document; restoring the version that is already current is a no-op,
 * and the restore lands in the audit trail in the same transaction.
 */
export async function restoreDocumentVersion(
  auth: AuthContext,
  input: { documentId: string; extractionId: string; expectedVersion: number },
) {
  return withTransaction(async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id, activeExtractionId: documents.activeExtractionId, title: documents.title })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)))
      .limit(1);
    if (!doc) throw new VersionRestoreError("not_found", "That document is not available.");

    const [extraction] = await tx
      .select({ id: documentExtractions.id, documentId: documentExtractions.documentId, status: documentExtractions.status, contentHash: documentExtractions.contentHash })
      .from(documentExtractions)
      .where(eq(documentExtractions.id, input.extractionId))
      .limit(1);
    if (!extraction || extraction.documentId !== doc.id) {
      throw new VersionRestoreError("not_found", "That version does not belong to this document.");
    }
    if (!canRestore(extraction, doc.id)) {
      throw new VersionRestoreError("not_succeeded", "Only a successfully read version can be restored.");
    }

    const current = await tx
      .select({ id: documentExtractions.id })
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, doc.id))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1);
    const currentId = doc.activeExtractionId ?? current[0]?.id ?? null;
    if (currentId === extraction.id) return { restored: false, activeExtractionId: currentId };

    const [row] = await tx
      .update(documents)
      .set({
        activeExtractionId: extraction.id,
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${documents.version} + 1`,
      })
      .where(and(eq(documents.id, doc.id), eq(documents.workspaceId, auth.workspaceId), eq(documents.version, input.expectedVersion)))
      .returning({ id: documents.id, version: documents.version });
    if (!row) throw new VersionRestoreError("stale_write", "That document changed. Reload to see the current state.");

    await recordAudit(
      auth,
      {
        action: "document.version_restored",
        subjectType: "document",
        subjectId: doc.id,
        summary: `Restored to version read from ${extraction.contentHash.slice(0, 12)}`,
        metadata: { extractionId: extraction.id, contentHash: extraction.contentHash, previousExtractionId: currentId },
      },
      tx,
    );
    return { restored: true, activeExtractionId: extraction.id };
  });
}

/**
 * A new extraction version supersedes any restore: the pin exists to look
 * back, and fresh bytes or a fresh read are newer truth. Called by the
 * extraction path whenever it creates a row for the document.
 */
export async function clearRestoreOnNewExtraction(documentId: string, executor: TxDrizzle | typeof db = db) {
  await executor
    .update(documents)
    .set({ activeExtractionId: null })
    .where(and(eq(documents.id, documentId), sql`${documents.activeExtractionId} is not null`));
}
