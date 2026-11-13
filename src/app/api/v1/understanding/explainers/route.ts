import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { kickGenerationJob } from "@/domains/jobs/kick";
import { actingAuth } from "@/domains/understanding/actor";
import { listExplainerViews, requestExplainer } from "@/domains/understanding/explainers";
import { understandingProblem } from "../problems";

/*
 * POST /api/v1/understanding/explainers - ask Polymath to explain one code
 * change. The explainer is written by a job, so this answers 202 with an id to
 * poll; a repeated requestKey answers with the first explainer instead of
 * making a second (200 once it is ready).
 * GET /api/v1/understanding/explainers?repo=&commit= - the explainers for one
 * commit, newest first, which is what a push hook asks.
 */

const requestSchema = z.object({
  repo: z.string().min(1).max(200),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/i),
  range: z.string().max(200).nullable(),
  summary: z.string().min(1).max(20_000),
  diff: z.string().min(1).max(450_000),
  requestKey: z.string().min(1).max(200),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  requireScope(auth, "understanding:write");
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problemResponse(422, "invalid_input", "Send repo, commit, range, summary, diff and requestKey.");
  }
  try {
    const { explainer, start } = await requestExplainer(await actingAuth(auth), parsed.data);
    if (start) kickGenerationJob({ jobId: start.jobId, attempt: start.attempt });
    return Response.json({ explainer }, { status: explainer.status === "ready" ? 200 : 202 });
  } catch (error) {
    return understandingProblem(error);
  }
});

const listSchema = z.object({ repo: z.string().min(1).max(200), commit: z.string().regex(/^[0-9a-f]{7,64}$/i) });

export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "viewer");
  requireScope(auth, "understanding:read");
  const params = new URL(request.url).searchParams;
  const parsed = listSchema.safeParse({ repo: params.get("repo"), commit: params.get("commit") });
  if (!parsed.success) return problemResponse(422, "invalid_input", "Send repo and commit.");
  try {
    return Response.json({ explainers: await listExplainerViews(await actingAuth(auth), parsed.data) });
  } catch (error) {
    return understandingProblem(error);
  }
});
