import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { SittingError } from "@/domains/knowledge/sittings";
import { startCreationRun } from "@/domains/knowledge/sitting-run";

/*
 * POST /api/v1/sittings/:sittingId/runs — start (or reuse) the sitting's one
 * creation run (§16.9 per-sitting cap). Quota admission happens here, once
 * per run (§16.4); the stream route never re-admits on reconnect.
 *
 * §16.6 route inventory: the sitting workspace drives runs through this
 * endpoint and follows them on the named stream endpoint; no eve guard -
 * creation runs execute in-process (§16.1), there is no bridge session.
 */

type Ctx = { params: Promise<{ sittingId: string }> };

const Body = z.object({ artifactId: z.string().uuid() });

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { sittingId } = await ctx.params;
  if (!z.string().uuid().safeParse(sittingId).success) return problemResponse(404, "not_found", "No such sitting.");
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return problemResponse(400, "invalid_body", "artifactId (uuid) is required.");
  try {
    const run = await startCreationRun(auth, { sittingId, artifactId: body.data.artifactId });
    return Response.json({ runId: run.runId, reused: run.reused }, { status: run.reused ? 200 : 201 });
  } catch (cause) {
    // §15.4: typed domain errors render as the standard error surface,
    // never as SSE events (the join never happened).
    if (cause instanceof SittingError) {
      return problemResponse(
        cause.code === "ARTIFACT_WORKSPACE_MISMATCH" ? 403 : 404,
        cause.code.toLowerCase(),
        cause.message,
      );
    }
    throw cause;
  }
});
