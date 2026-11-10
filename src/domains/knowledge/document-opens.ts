import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { documentReadingState, documents } from "./schema";

/*
 * A document open, recorded when the Vault's document detail (?doc=<id>)
 * mounts. It is the one writer of document_reading_state since the Library
 * reader was removed: the row is per (document, user), so opening moves only
 * the caller's own count and lastOpenedAt. Knowledge debt reads the row's
 * existence as "this document has been opened".
 *
 * Returns false, writing nothing, when the document is not a live document in
 * the caller's workspace.
 */
export async function recordDocumentOpen(auth: AuthContext, documentId: string): Promise<boolean> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.id, documentId), isNull(documents.archivedAt)))
    .limit(1);
  if (!doc) return false;

  await db
    .insert(documentReadingState)
    .values({
      workspaceId: auth.workspaceId,
      documentId,
      userId: auth.userId,
      openCount: 1,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoUpdate({
      target: [documentReadingState.workspaceId, documentReadingState.documentId, documentReadingState.userId],
      set: {
        openCount: sql`${documentReadingState.openCount} + 1`,
        lastOpenedAt: sql`now()`,
        updatedBy: auth.userId,
        updatedAt: sql`now()`,
        version: sql`${documentReadingState.version} + 1`,
      },
    });
  return true;
}
