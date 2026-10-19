import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { ExportPacketError, assembleExportPacket } from "@/domains/knowledge/packets";

/*
 * POST /api/v1/exports/manifests/:manifestId/packet - assemble the immutable
 * zip of the manifest's pinned versions. Assembly is a derived artifact: it
 * never mutates the manifest, and the optional expectedManifestVersion lets
 * the caller refuse to packet a manifest that changed under it.
 */
type Ctx = { params: Promise<{ manifestId: string }> };

const bodySchema = z.object({ expectedManifestVersion: z.number().int().min(1).optional() }).nullish();

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { manifestId } = await ctx.params;
  if (!z.string().uuid().safeParse(manifestId).success) return problemResponse(404, "not_found", "No such export manifest in this workspace.");
  const body = bodySchema.parse(await request.json().catch(() => null));
  try {
    const result = await assembleExportPacket(auth, { manifestId, expectedManifestVersion: body?.expectedManifestVersion });
    return Response.json({ ok: true, ...result, downloadPath: `/api/v1/exports/packets/${result.packetId}` });
  } catch (cause) {
    if (cause instanceof ExportPacketError) return problemResponse(cause.code === "not_found" ? 404 : 409, cause.code, cause.message);
    throw cause;
  }
});
