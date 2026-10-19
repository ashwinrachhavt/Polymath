import { and, count, desc, eq, inArray } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documents, documentTags } from "./schema";

/*
 * Free tags on documents: normalized lowercase, one row per (document, tag).
 * Signatures are batch-shaped to match the Files surface UI. Tagging is
 * idempotent (the unique key folds a re-tag), untagging removes only the
 * named tag, and a foreign or archived document id fails the whole command.
 */

export class TagError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_tag",
    message: string,
  ) {
    super(message);
  }
}

export const MAX_BATCH = 200;

/** Lowercase, collapse whitespace, trim. The check constraint on the table is the same rule. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function requireTag(raw: string): string {
  const tag = normalizeTag(raw);
  if (tag.length < 1 || tag.length > 40) throw new TagError("invalid_tag", "Tags are 1-40 characters.");
  return tag;
}

async function requireOwnedDocuments(auth: AuthContext, documentIds: string[]): Promise<string[]> {
  const ids = [...new Set(documentIds)];
  if (ids.length === 0 || ids.length > MAX_BATCH) throw new TagError("not_found", "No documents selected.");
  const owned = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, ids)));
  if (owned.length !== ids.length) throw new TagError("not_found", "One or more documents are not in this workspace.");
  return ids;
}

export async function addTag(auth: AuthContext, input: { documentIds: string[]; tag: string }) {
  const tag = requireTag(input.tag);
  const ids = await requireOwnedDocuments(auth, input.documentIds);
  await withTransaction(async (tx) => {
    await tx
      .insert(documentTags)
      .values(ids.map((documentId) => ({ workspaceId: auth.workspaceId, documentId, tag, createdBy: auth.userId })))
      .onConflictDoNothing();
    await recordAudit(
      auth,
      {
        action: "document.tagged",
        subjectType: "document",
        subjectId: ids[0],
        summary: `Tagged ${ids.length === 1 ? "1 document" : `${ids.length} documents`} "${tag}"`,
        metadata: { tag, documentIds: ids },
      },
      tx,
    );
  });
  return { tag, documentIds: ids };
}

export async function removeTag(auth: AuthContext, input: { documentIds: string[]; tag: string }) {
  const tag = requireTag(input.tag);
  const ids = await requireOwnedDocuments(auth, input.documentIds);
  await db
    .delete(documentTags)
    .where(and(eq(documentTags.workspaceId, auth.workspaceId), eq(documentTags.tag, tag), inArray(documentTags.documentId, ids)));
  return { tag, documentIds: ids };
}

/** The tags of a set of documents, as a map the list/detail reads merge in. */
export async function getDocumentTags(auth: AuthContext, documentIds: string[]): Promise<Map<string, string[]>> {
  const byDocument = new Map<string, string[]>();
  if (documentIds.length === 0) return byDocument;
  const rows = await db
    .select({ documentId: documentTags.documentId, tag: documentTags.tag })
    .from(documentTags)
    .where(and(eq(documentTags.workspaceId, auth.workspaceId), inArray(documentTags.documentId, documentIds)));
  for (const row of rows) {
    const list = byDocument.get(row.documentId) ?? [];
    list.push(row.tag);
    byDocument.set(row.documentId, list);
  }
  for (const list of byDocument.values()) list.sort();
  return byDocument;
}

/** Every tag in the workspace with its document count, most used first - the filter rail's content. */
export async function listTags(auth: AuthContext) {
  return db
    .select({ tag: documentTags.tag, documentCount: count() })
    .from(documentTags)
    .where(eq(documentTags.workspaceId, auth.workspaceId))
    .groupBy(documentTags.tag)
    .orderBy(desc(count()), documentTags.tag);
}
