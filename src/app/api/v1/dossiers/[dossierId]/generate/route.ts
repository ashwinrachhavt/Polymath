import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { createEngine } from "@/domains/agents/engine";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { ensureProfile } from "@/domains/agents/commands";
import { StudioError, startStudioGenerate } from "@/domains/knowledge/studio";

/* POST /api/v1/dossiers/:dossierId/generate — Studio Generate: starts a run bound to the dossier. It never publishes. */
type Ctx = { params: Promise<{ dossierId: string }> };

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { dossierId } = await ctx.params;
  const id = z.string().uuid().safeParse(dossierId);
  const body = z.object({ brief: z.string().min(1).max(2000) }).safeParse(await request.json().catch(() => null));
  if (!id.success) return problemResponse(404, "not_found", "No such dossier.");
  if (!body.success) return problemResponse(422, "invalid_input", "Say what to generate.");
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);
  try {
    await ensureProfile(auth.workspaceId);
    const { runId } = await startStudioGenerate(auth, { dossierId: id.data, brief: body.data.brief }, createEngine(createEveDriver()));
    return Response.json({ runId }, { status: 201 });
  } catch (cause) {
    if (cause instanceof StudioError) return problemResponse(404, cause.code, cause.message);
    throw cause;
  }
});
