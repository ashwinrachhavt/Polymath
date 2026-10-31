import { and, desc, eq } from "drizzle-orm";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { serveBlob } from "@/lib/blob-serve";
import { db } from "@/lib/db";
import { blobObjects } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";

/*
 * GET /api/v1/documents/:documentId/file - the document's bytes, inline, for
 * the vault's split viewer. The blob store is private; the workspace check
 * happens here and the stored key is never guessable. Rendered inline (not as
 * an attachment) so an <iframe> or <img> can show it; PDFs get the browser's
 * own viewer, images the <img> element, anything else a download.
 */
export const GET = authedHandler(async (auth, _request, ctx: { params: Promise<{ documentId: string }> }) => {
  requireRole(auth, "viewer");
  const { documentId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return problemResponse(404, "not_found", "No such document in this workspace.");

  const [row] = await db
    .select({ storageKey: blobObjects.storageKey, mimeType: blobObjects.mimeType, filename: files.filename, sizeBytes: blobObjects.sizeBytes })
    .from(documents)
    .innerJoin(files, eq(files.id, documents.fileId))
    .innerJoin(blobObjects, eq(blobObjects.id, files.blobId))
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .orderBy(desc(files.createdAt))
    .limit(1);
  if (!row) return problemResponse(404, "not_found", "This document has no stored file — it may be a captured web page.");

  return serveBlob({
    storageKey: row.storageKey,
    contentType: row.mimeType ?? "application/octet-stream",
    inline: true,
    filename: row.filename ?? "document",
    sizeBytes: row.sizeBytes,
    label: "document",
  });
});
