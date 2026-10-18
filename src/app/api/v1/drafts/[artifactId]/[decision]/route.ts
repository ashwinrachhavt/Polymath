import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { StudioError, discardDraft, saveDraft } from "@/domains/knowledge/studio";

/* POST /api/v1/drafts/:artifactId/save|discard — the owner's decision. Save keeps it as reviewed; nothing here publishes. */
type Ctx = { params: Promise<{ artifactId: string; decision: string }> };

export const POST = authedHandler<Ctx>(async (auth, _request, ctx) => {
  requireRole(auth, "member");
  const { artifactId, decision } = await ctx.params;
  if (!z.string().uuid().safeParse(artifactId).success || !["save", "discard"].includes(decision)) {
    return problemResponse(404, "not_found", "No such draft.");
  }
  try {
    await (decision === "save" ? saveDraft : discardDraft)(auth, { artifactId });
    return Response.json({ ok: true });
  } catch (cause) {
    if (cause instanceof StudioError) return problemResponse(409, cause.code, cause.message);
    throw cause;
  }
});
