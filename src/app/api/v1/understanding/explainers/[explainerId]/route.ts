import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { actingAuth } from "@/domains/understanding/actor";
import { getExplainerView } from "@/domains/understanding/explainers";
import { understandingProblem } from "../../problems";

/* GET /api/v1/understanding/explainers/:id - one explainer's state: pending, ready or failed. */
export const GET = authedHandler<{ params: Promise<{ explainerId: string }> }>(async (auth, _request, ctx) => {
  requireRole(auth, "viewer");
  requireScope(auth, "understanding:read");
  const { explainerId } = await ctx.params;
  if (!z.uuid().safeParse(explainerId).success) return problemResponse(404, "not_found", "No such explainer.");
  try {
    const explainer = await getExplainerView(await actingAuth(auth), explainerId);
    if (!explainer) return problemResponse(404, "not_found", "No such explainer.");
    return Response.json({ explainer });
  } catch (error) {
    return understandingProblem(error);
  }
});
