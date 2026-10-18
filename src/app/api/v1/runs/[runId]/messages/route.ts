import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { sendFollowUp } from "@/domains/agents/thread";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";

/*
 * POST /api/v1/runs/:runId/messages — a follow-up on a live run. A finished
 * run answers 409 run_finished (retry makes a new run), and a run in another
 * workspace answers the same 404 as a missing one.
 */
type Ctx = { params: Promise<{ runId: string }> };

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { runId } = await ctx.params;
  if (!z.string().uuid().safeParse(runId).success) return problemResponse(404, "not_found", "No such run.");
  const body = z.object({ message: z.string().min(1).max(4000) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return problemResponse(422, "invalid_input", "Give a message of up to 4000 characters.");
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);

  const result = await sendFollowUp(auth, runId, body.data.message);
  if (result.ok) return Response.json({ ok: true }, { status: 202 });
  if (result.code === "not_found") return problemResponse(404, "not_found", result.message);
  if (result.code === "run_finished") return problemResponse(409, "run_finished", result.message);
  return problemResponse(422, "invalid_input", result.message);
});
