import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { withTransaction } from "@/lib/db-transaction";
import { retractEvidence } from "./parties";
import { documents } from "./schema";

/*
 * Document lifecycle commands that touch more than the document row. The
 * first one is archiving: a document's assertions never silently survive its
 * removal (ASH-128) - retracting them lands in the same transaction as the
 * archive, so the ledger and the library can never disagree about whether
 * the evidence still stands. The assertion rows stay, marked retracted;
 * reviewed records are never erased.
 */

/** §14.10 inbox source chip: workspace-scoped title lookup for a seeded sitting's document. */
export async function getDocumentTitle(auth: AuthContext, documentId: string): Promise<string | null> {
  const [row] = await db
    .select({ title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  return row?.title ?? null;
}

export class DocumentLifecycleError extends Error {
  constructor(
    public readonly code: "not_found" | "stale_write" | "already_archived",
    message: string,
  ) {
    super(message);
    this.name = "DocumentLifecycleError";
  }
}

export async function archiveDocument(
  auth: AuthContext,
  input: { documentId: string; expectedVersion: number },
): Promise<{ archived: boolean; retractedAssertions: number }> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(documents)
      .set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documents.version} + 1` })
      .where(
        and(
          eq(documents.id, input.documentId),
          eq(documents.workspaceId, auth.workspaceId),
          eq(documents.version, input.expectedVersion),
        ),
      )
      .returning({ id: documents.id, archivedAt: documents.archivedAt });
    if (!row) {
      const [existing] = await tx
        .select({ id: documents.id, archivedAt: documents.archivedAt })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!existing) throw new DocumentLifecycleError("not_found", "That document is not available.");
      if (existing.archivedAt) throw new DocumentLifecycleError("already_archived", "That document is already archived.");
      throw new DocumentLifecycleError("stale_write", "That document changed. Reload to see the current state.");
    }

    const { retracted } = await retractEvidence(auth, { documentId: input.documentId }, tx);

    await recordAudit(
      auth,
      {
        action: "document.archived",
        subjectType: "document",
        subjectId: input.documentId,
        summary: `Archived; ${retracted} assertion(s) retracted`,
        metadata: { retractedAssertions: retracted },
      },
      tx,
    );
    return { archived: true, retractedAssertions: retracted };
  });
}
