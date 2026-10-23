import { and, eq, inArray } from "drizzle-orm";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { db } from "@/lib/db";
import { readBlob } from "@/integrations/object-store/object-store";
import { blobObjects } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";

/*
 * GET /api/v1/captures/:captureId/file - the captured blob's bytes (file and
 * voice captures share this one download path). The blob store is private;
 * the workspace check happens here and the stored key is never guessable.
 * The served type is the server's sniffed verdict, never the uploader's
 * claim. Only sniffed images/PDF/plain text and sniffed audio render inline
 * (audio needs inline + byte ranges for the detail panel's player); a
 * QUARANTINED capture (sniff failed) is always an octet-stream attachment -
 * preserved for the owner, never executable, renderable or playable in the
 * browser. nosniff rides every response so the advertised type cannot be
 * second-guessed.
 *
 * Byte ranges: single "bytes=start-end" requests get a 206 slice with
 * Content-Range; every response advertises Accept-Ranges: bytes. Ranges are
 * honored only for inline content - a quarantined attachment always arrives
 * whole. Chrome's audio element issues range requests, so playable audio
 * needs this, not just the right magic bytes.
 */

const INLINE_SAFE = new Set([
  "image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain",
  "audio/wav", "audio/mpeg", "audio/ogg", "audio/flac", "audio/mp4", "audio/webm",
]);

export const GET = authedHandler(async (auth, _request, ctx: { params: Promise<{ captureId: string }> }) => {
  requireRole(auth, "viewer");
  const { captureId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(captureId)) return problemResponse(404, "not_found", "No such capture in this workspace.");

  const [row] = await db
    .select({ storageKey: blobObjects.storageKey, mimeType: blobObjects.mimeType, sizeBytes: blobObjects.sizeBytes, rawPayload: captures.rawPayload })
    .from(captures)
    .innerJoin(blobObjects, eq(blobObjects.id, captures.blobId))
    .where(and(eq(captures.id, captureId), eq(captures.workspaceId, auth.workspaceId), inArray(captures.kind, ["file", "voice"])))
    .limit(1);
  if (!row) return problemResponse(404, "not_found", "This capture has no stored file.");

  const payload = (row.rawPayload ?? {}) as { filename?: string; quarantined?: boolean };
  const quarantined = payload.quarantined === true;
  const filename = (payload.filename ?? "capture").replace(/["\\]/g, "");

  let bytes: Uint8Array;
  try {
    bytes = await readBlob(row.storageKey);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return problemResponse(
      missing ? 404 : 500,
      missing ? "file_unavailable" : "file_read_failed",
      missing
        ? "The stored file for this capture is not reachable from this server."
        : "The stored file for this capture could not be read.",
    );
  }

  const inline = !quarantined && INLINE_SAFE.has(row.mimeType);
  const total = row.sizeBytes ?? bytes.byteLength;
  const baseHeaders: Record<string, string> = {
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=60",
    "Accept-Ranges": "bytes",
  };

  // Single-range support for inline content (the detail panel's audio
  // player). A malformed or unsatisfiable range answers 416 with the real
  // total, per RFC 9110 - never a silent 200 that hides the mismatch.
  const rangeHeader = inline ? _request.headers.get("range") : null;
  const rangeMatch = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (rangeMatch && (rangeMatch[1] !== "" || rangeMatch[2] !== "")) {
    let start = rangeMatch[1] === "" ? Math.max(0, total - Number(rangeMatch[2])) : Number(rangeMatch[1]);
    let end = rangeMatch[1] === "" ? total - 1 : rangeMatch[2] === "" ? total - 1 : Math.min(Number(rangeMatch[2]), total - 1);
    if (start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${total}` } });
    }
    return new Response(Buffer.from(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Type": row.mimeType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
    });
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      ...baseHeaders,
      "Content-Type": inline ? row.mimeType : "application/octet-stream",
      "Content-Length": String(total),
    },
  });
});
