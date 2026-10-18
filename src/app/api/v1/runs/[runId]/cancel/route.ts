import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { createEngine } from "@/domains/agents/engine";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";

/*
 * POST /api/v1/runs/:runId/cancel — flips the run to cancelled, tells Eve to
 * cancel the in-flight turn, releases the budget and writes a `cancelled`
 * event to the thread. A run that is already finished answers 409.
 */
type Ctx = { params: Promise<{ runId: string }> };

export const POST = authedHandler<Ctx>(async (auth, _request, ctx) => {
  requireRole(auth, "member");
  const { runId } = await ctx.params;
  if (!z.string().uuid().safeParse(runId).success) return problemResponse(404, "not_found", "No such run.");
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);
  try {
    const { cancelled } = await createEngine(createEveDriver()).cancel(runId, auth);
    if (!cancelled) return problemResponse(409, "run_finished", "This run is already finished.");
    return Response.json({ cancelled: true });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "run not found in workspace") {
      return problemResponse(404, "not_found", "No such run.");
    }
    throw cause;
  }
});
