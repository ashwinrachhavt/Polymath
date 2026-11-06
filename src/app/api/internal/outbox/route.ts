import postgres from "postgres";
import { timingSafeEqual } from "node:crypto";
import { dispatchPendingOutbox, recoverStrandedOutbox } from "@/domains/audit/outbox";
import { outboxHandlers } from "@/domains/audit/outbox-handlers";
import { problemResponse } from "@/lib/problems";
import { rawQueryDebugger, withQueryLog } from "@/lib/db-query-log";
import { superagentEffectHandlers, sweepSuperagentWorkspaces } from "@/domains/superagent/wiring";
import { runSuperagentDispatch } from "@/domains/superagent/effects";

/*
 * POST /api/internal/outbox - one dispatcher pass (ASH-134 Q03). Off unless
 * OUTBOX_DISPATCH_SECRET is set; callable by an external scheduler or a worker
 * with that bearer. No cron is registered here: the free Vercel plan runs
 * crons at most daily, so the trigger is the operator's choice.
 */
function authorized(request: Request, secret: string): boolean {
  const presented = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret) return problemResponse(404, "not_found", "Not found.");
  if (!authorized(request, secret)) return problemResponse(401, "unauthorized", "Unauthorized.");

  const client = postgres(process.env.DATABASE_URL ?? "", { max: 1, debug: rawQueryDebugger });
  try {
    const recovered = await withQueryLog("outbox.recover_stranded", () => recoverStrandedOutbox(client));
    const result = await withQueryLog("outbox.dispatch", () =>
      dispatchPendingOutbox(client, outboxHandlers(), { workerId: `route:${crypto.randomUUID()}` }),
    );
    // The superagent domain's effects and reply lane drain in the same pass.
    // The sweep first: the engine's serverless tick (start due evals — the
    // step that enqueues the assessment effects this pass then claims) plus
    // the ticket-run observer. The wiring's handler map adds the assessor's
    // and executor's consumers (and the chat sink for the reply lane); kinds
    // without a consumer park without failure, so a wave that lands before
    // its consumer never turns intent into errors.
    await withQueryLog("outbox.superagent_sweep", () => sweepSuperagentWorkspaces());
    const superagent = await withQueryLog("outbox.superagent_dispatch", async () =>
      runSuperagentDispatch(client, await superagentEffectHandlers(), {
        workerId: `route:${crypto.randomUUID()}`,
      }),
    );
    return Response.json({ recovered: recovered.length, ...result, superagent });
  } finally {
    await client.end({ timeout: 5 });
  }
}
