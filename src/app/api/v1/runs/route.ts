import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { requestReceipts } from "@/domains/audit/schema";
import { problemResponse } from "@/lib/problems";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { createEngine } from "@/domains/agents/engine";
import { ensureProfile } from "@/domains/agents/commands";
import { listRecentRuns } from "@/domains/agents/queries";

/*
 * GET /api/v1/runs — the workspace's recent agent runs; the Alfred page reads
 * this through its server component.
 *
 * POST /api/v1/runs — start a run for the signed-in user's workspace. The
 * engine does the ordering (run row, then reservation, then session); this
 * handler authenticates, parses, and makes the start idempotent.
 *
 * Idempotency-Key (a UUID) names one start. The receipt row is claimed before
 * the engine runs, so a retry or a double-click with the same key returns the
 * first run instead of starting a second Eve session. The same key with a
 * different body is a 422; a key whose first call is still running is a 409.
 * The Eve session itself is also create-once (`operationId` in the driver).
 */

const startRun = z.object({
  objective: z.string().min(1).max(2000),
  estimateUsd: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .default("0.50"),
  profileName: z.string().default("alfred"),
});

export const GET = authedHandler(async (auth) => {
  const runs = await listRecentRuns(auth.workspaceId);
  return Response.json({ runs });
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const parsed = startRun.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problemResponse(422, "invalid_input", "Give an objective (and optionally an estimateUsd).");
  }
  const key = request.headers.get("idempotency-key");
  if (key !== null && !z.string().uuid().safeParse(key).success) {
    return problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID.");
  }
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);

  const receipt = key
    ? { key, hash: await sha256Hex(JSON.stringify([parsed.data.objective, parsed.data.profileName, parsed.data.estimateUsd])) }
    : null;
  if (receipt) {
    const [claimed] = await db
      .insert(requestReceipts)
      .values({
        workspaceId: auth.workspaceId,
        idempotencyKey: receipt.key,
        requestHash: receipt.hash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: requestReceipts.id });
    if (!claimed) {
      const [prior] = await db
        .select({ requestHash: requestReceipts.requestHash, response: requestReceipts.response })
        .from(requestReceipts)
        .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, receipt.key)))
        .limit(1);
      if (prior?.requestHash !== receipt.hash) {
        return problemResponse(422, "idempotency_conflict", "This key was used for a different request.");
      }
      if (!prior.response) {
        return problemResponse(409, "request_in_progress", "This run is still starting. Retry in a moment.");
      }
      return Response.json(prior.response, { status: 201 });
    }
  }

  try {
    const engine = createEngine(createEveDriver());
    await ensureProfile(auth.workspaceId, parsed.data.profileName);
    const { runId } = await engine.start({
      auth,
      profileName: parsed.data.profileName,
      objective: parsed.data.objective,
      subjects: [],
      estimateUsd: parsed.data.estimateUsd,
    });
    if (receipt) {
      await db
        .update(requestReceipts)
        .set({ statusCode: 201, response: { runId } })
        .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, receipt.key)));
    }
    return Response.json({ runId }, { status: 201 });
  } catch (cause) {
    // The engine closed the run and returned the budget; free the key so a retry can start fresh.
    if (receipt) {
      await db
        .delete(requestReceipts)
        .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, receipt.key)));
    }
    // A failed start is a problem response, never a bare 500 with no body.
    console.error("run start failed", cause);
    return problemResponse(502, "agent_start_failed", "The run could not be started. Try again.");
  }
});
