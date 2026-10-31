import { and, eq } from "drizzle-orm";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { serveBlob } from "@/lib/blob-serve";
import { db } from "@/lib/db";
import { blobObjects } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";

/*
 * GET /api/v1/captures/:captureId/file - the captured file's bytes. The blob
 * store is private; the workspace check happens here and the stored key is
 * never guessable. The served type is the server's sniffed verdict, never the
 * uploader's claim. Only sniffed images/PDF/plain text render inline; a
 * QUARANTINED capture (sniff failed) is always an octet-stream attachment -
 * preserved for the owner, never executable or renderable in the browser.
 * nosniff rides every response so the advertised type cannot be second-guessed.
 */

const INLINE_SAFE = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"]);

export const GET = authedHandler(async (auth, _request, ctx: { params: Promise<{ captureId: string }> }) => {
  requireRole(auth, "viewer");
  const { captureId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(captureId)) return problemResponse(404, "not_found", "No such capture in this workspace.");

  const [row] = await db
    .select({ storageKey: blobObjects.storageKey, mimeType: blobObjects.mimeType, sizeBytes: blobObjects.sizeBytes, rawPayload: captures.rawPayload })
    .from(captures)
    .innerJoin(blobObjects, eq(blobObjects.id, captures.blobId))
    .where(and(eq(captures.id, captureId), eq(captures.workspaceId, auth.workspaceId), eq(captures.kind, "file")))
    .limit(1);
  if (!row) return problemResponse(404, "not_found", "This capture has no stored file.");

  const payload = (row.rawPayload ?? {}) as { filename?: string; quarantined?: boolean };
  const quarantined = payload.quarantined === true;
  const filename = (payload.filename ?? "capture").replace(/["\\]/g, "");

  const inline = !quarantined && INLINE_SAFE.has(row.mimeType);
  return serveBlob({
    storageKey: row.storageKey,
    contentType: row.mimeType,
    inline,
    filename,
    sizeBytes: row.sizeBytes,
    label: "capture",
  });
});
