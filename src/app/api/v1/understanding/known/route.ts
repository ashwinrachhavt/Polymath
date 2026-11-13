import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { actingAuth } from "@/domains/understanding/actor";
import { knownConcepts } from "@/domains/understanding/known";
import { understandingProblem } from "../problems";

/*
 * GET /api/v1/understanding/known?topic= - the concepts this person has been
 * checked on, as known, shaky or unassessed, so an agent can skip what they
 * already understand. The topic narrows by concept name; leave it out for the
 * most recent concepts.
 */
export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "viewer");
  requireScope(auth, "understanding:read");
  const topic = new URL(request.url).searchParams.get("topic")?.slice(0, 200) || null;
  try {
    return Response.json({ topic, concepts: await knownConcepts(await actingAuth(auth), topic ?? undefined) });
  } catch (error) {
    return understandingProblem(error);
  }
});
