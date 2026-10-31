import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { serveBlob } from "@/lib/blob-serve";
import { getExportPacketBlob } from "@/domains/knowledge/packets";

/*
 * GET /api/v1/exports/packets/:packetId - download one assembled packet.
 * The blob is private; the workspace check happens in the query, and the
 * stored key is never guessable from the packet id.
 */
type Ctx = { params: Promise<{ packetId: string }> };

export const GET = authedHandler<Ctx>(async (auth, _request, ctx) => {
  requireRole(auth, "viewer");
  const { packetId } = await ctx.params;
  if (!z.string().uuid().safeParse(packetId).success) return problemResponse(404, "not_found", "No such packet in this workspace.");
  const packet = await getExportPacketBlob(auth, { packetId });
  if (!packet) return problemResponse(404, "not_found", "No such packet in this workspace.");
  const name = packet.manifestName.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "packet";
  return serveBlob({
    storageKey: packet.storageKey,
    contentType: "application/zip",
    inline: false,
    filename: `${name}.zip`,
    sizeBytes: packet.sizeBytes,
    label: "packet",
    cacheControl: "private, no-store",
    headers: { "X-Content-SHA256": packet.contentHash },
  });
});
