import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { getExportPacketBlob } from "@/domains/knowledge/packets";
import { readBlob } from "@/integrations/object-store/object-store";

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
  const bytes = await readBlob(packet.storageKey);
  const name = packet.manifestName.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "packet";
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(packet.sizeBytes),
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-SHA256": packet.contentHash,
    },
  });
});
