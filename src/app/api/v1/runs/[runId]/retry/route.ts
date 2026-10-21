import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { retryRun } from "@/domains/agents/thread";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";

/*
 * POST /api/v1/runs/:runId/retry — starts a new run from a finished run's
 * objective. The new run has its own id; the old thread stays as it was.
 */
type Ctx = { params: Promise<{ runId: string }> };

export const POST = authedHandler<Ctx>(async (auth, _request, ctx) => {
  requireRole(auth, "member");
  const { runId } = await ctx.params;
  if (!z.string().uuid().safeParse(runId).success) return problemResponse(404, "not_found", "No such run.");
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);
  try {
    const result = await retryRun(auth, runId);
    if (result.ok) return Response.json({ runId: result.runId }, { status: 201 });
    return problemResponse(result.code === "not_found" ? 404 : 409, result.code, result.message);
  } catch (cause) {
    /*
     * A retry re-pins the original run's skill, so it fails exactly where the
     * start route does when that skill was disabled or archived in between.
     * The same cause gets the same answer here rather than an unhandled 500
     * with no problem body: the person reads one copy whichever route they used.
     */
    if (cause instanceof Error && cause.message.startsWith("That skill is not available")) {
      return problemResponse(404, "not_found", cause.message);
    }
    console.error("run retry failed", cause);
    return problemResponse(502, "agent_start_failed", "The run could not be started. Try again.");
  }
});
