import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { requestReceipts } from "@/domains/audit/schema";
import { problemResponse } from "@/lib/problems";
import { createEngine } from "@/domains/agents/engine";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { ensureProfile } from "@/domains/agents/commands";
import { GENERATABLE_KINDS, StudioError, startStudioGenerate } from "@/domains/knowledge/studio";

/* POST /api/v1/projects/:projectId/generate — Studio Generate: starts a run bound to the project. It never publishes. */
type Ctx = { params: Promise<{ projectId: string }> };

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { projectId } = await ctx.params;
  const id = z.string().uuid().safeParse(projectId);
  const body = z
    .object({ brief: z.string().min(1).max(2000), kind: z.enum(GENERATABLE_KINDS).optional() })
    .safeParse(await request.json().catch(() => null));
  if (!id.success) return problemResponse(404, "not_found", "No such project.");
  if (!body.success) return problemResponse(422, "invalid_input", "Say what to generate.");
  // Same contract as POST /v1/runs: the key names one start, so a double click
  // or a network retry cannot start two paid runs. Claim the receipt before the
  // engine runs; the same key with a different body is a conflict.
  const key = request.headers.get("idempotency-key");
  if (key === null || !z.string().uuid().safeParse(key).success) {
    return problemResponse(422, "invalid_input", "Send an Idempotency-Key header: a UUID naming this one start.");
  }
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);
  const requestHash = await sha256Hex(JSON.stringify([id.data, body.data.brief, body.data.kind ?? null]));
  const [claimed] = await db
    .insert(requestReceipts)
    .values({
      workspaceId: auth.workspaceId,
      idempotencyKey: key,
      requestHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: requestReceipts.id });
  if (!claimed) {
    const [prior] = await db
      .select({ requestHash: requestReceipts.requestHash, response: requestReceipts.response })
      .from(requestReceipts)
      .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)))
      .limit(1);
    if (prior?.requestHash !== requestHash) {
      return problemResponse(422, "idempotency_conflict", "This key was used for a different request.");
    }
    if (!prior?.response) {
      return problemResponse(409, "request_in_progress", "This run is still starting. Retry in a moment.");
    }
    return Response.json(prior.response, { status: 201 });
  }
  try {
    await ensureProfile(auth.workspaceId);
    const { runId } = await startStudioGenerate(auth, { projectId: id.data, brief: body.data.brief, kind: body.data.kind }, createEngine(createEveDriver()));
    await db
      .update(requestReceipts)
      .set({ statusCode: 201, response: { runId } })
      .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)));
    return Response.json({ runId }, { status: 201 });
  } catch (cause) {
    // The start failed: free the key so a retry can try again.
    await db
      .delete(requestReceipts)
      .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, key)));
    if (cause instanceof StudioError) return problemResponse(404, cause.code, cause.message);
    throw cause;
  }
});
