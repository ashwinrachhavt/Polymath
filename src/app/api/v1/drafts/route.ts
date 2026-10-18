import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { StudioError, saveGeneratedDraft } from "@/domains/knowledge/studio";

/* POST /api/v1/drafts { runId } — turns a Studio run's output into a draft artifact (once per run). */
export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const body = z.object({ runId: z.string().uuid(), title: z.string().max(200).optional() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return problemResponse(422, "invalid_input", "Give a runId.");
  try {
    const result = await saveGeneratedDraft(auth, body.data);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (cause) {
    if (cause instanceof StudioError) return problemResponse(cause.code === "no_output" ? 409 : 404, cause.code, cause.message);
    throw cause;
  }
});
