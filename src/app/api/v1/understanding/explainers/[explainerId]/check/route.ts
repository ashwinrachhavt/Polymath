import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { actingAuth } from "@/domains/understanding/actor";
import { getCheck, submitCheck } from "@/domains/understanding/check";
import { understandingProblem } from "../../../problems";

/*
 * GET /api/v1/understanding/explainers/:id/check - the questions, without
 * their answers; 409 not_ready while the explainer is still being written.
 * POST - grade a sitting. A question left out counts as "I don't know". The
 * result names what was missed and how many review items it added.
 */

const answersSchema = z.object({
  answers: z.array(z.object({ questionId: z.uuid(), value: z.string().max(60).nullable() })).max(25),
});

type Ctx = { params: Promise<{ explainerId: string }> };

export const GET = authedHandler<Ctx>(async (auth, _request, ctx) => {
  requireRole(auth, "viewer");
  requireScope(auth, "understanding:read");
  const { explainerId } = await ctx.params;
  if (!z.uuid().safeParse(explainerId).success) return problemResponse(404, "not_found", "No such explainer.");
  try {
    return Response.json(await getCheck(await actingAuth(auth), explainerId));
  } catch (error) {
    return understandingProblem(error);
  }
});

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  requireScope(auth, "understanding:write");
  const { explainerId } = await ctx.params;
  if (!z.uuid().safeParse(explainerId).success) return problemResponse(404, "not_found", "No such explainer.");
  const parsed = answersSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(422, "invalid_input", "Send answers as [{ questionId, value }].");
  try {
    return Response.json(await submitCheck(await actingAuth(auth), explainerId, parsed.data.answers));
  } catch (error) {
    return understandingProblem(error);
  }
});
