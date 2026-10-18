import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { problemResponse } from "@/lib/problems";
import { getRun } from "@/domains/agents/queries";

/*
 * GET /api/v1/runs/:runId — one run, only for the workspace that owns it.
 * A foreign run and a missing run are the same 404.
 */
export const GET = authedHandler<{ params: Promise<{ runId: string }> }>(async (auth, _request, ctx) => {
  const { runId } = await ctx.params;
  if (!z.string().uuid().safeParse(runId).success) return problemResponse(404, "not_found", "No such run.");
  const run = await getRun(auth.workspaceId, runId);
  if (!run) return problemResponse(404, "not_found", "No such run.");
  return Response.json({ run });
});
