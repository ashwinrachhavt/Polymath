import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { problemResponse } from "@/lib/problems";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { createEngine } from "@/domains/agents/engine";
import { ensureProfile } from "@/domains/agents/commands";
import { listRecentRuns } from "@/domains/agents/queries";

/*
 * GET /api/v1/runs — the workspace's recent agent runs; the Alfred page reads
 * this through its server component.
 *
 * POST /api/v1/runs — start a run. The engine does the ordering (run row, then
 * reservation, then session); this handler only authenticates and parses.
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
  const parsed = startRun.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problemResponse(422, "invalid_input", "Give an objective (and optionally an estimateUsd).");
  }
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);
  const engine = createEngine(createEveDriver());
  await ensureProfile(auth.workspaceId, parsed.data.profileName);
  const { runId } = await engine.start({
    auth,
    profileName: parsed.data.profileName,
    objective: parsed.data.objective,
    subjects: [],
    estimateUsd: parsed.data.estimateUsd,
  });
  return Response.json({ runId }, { status: 201 });
});
