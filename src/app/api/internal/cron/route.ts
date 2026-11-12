import postgres from "postgres";
import { timingSafeEqual } from "node:crypto";
import { reconcileUnknownAttempts } from "@/domains/actions/reconciliation";
import { dispatchPendingOutbox, recoverStrandedOutbox } from "@/domains/audit/outbox";
import { outboxHandlers } from "@/domains/audit/outbox-handlers";
import { syncAllGmailSenders } from "@/domains/crm/sender-sync";
import { scheduleMonthlyFactRefresh } from "@/domains/facts/schedule";
import { scheduleDailyMemoryDreams } from "@/domains/agents/memory-schedule";
import { scheduleDailyTidyPasses } from "@/domains/knowledge/tidy";
import { InstantTools } from "@/domains/integrations/instant-tools";
import { composioTransport } from "@/domains/integrations/transport";
import { runSuperagentDispatch } from "@/domains/superagent/effects";
import { superagentEffectHandlers, sweepSuperagentWorkspaces } from "@/domains/superagent/wiring";
import { reapStaleReservations } from "@/integrations/providers/quota";
import { problemResponse } from "@/lib/problems";
import { rawQueryDebugger, withQueryLog } from "@/lib/db-query-log";

/*
 * POST /api/internal/cron - one dispatcher pass, for a scheduler.
 *
 * Same contract as /api/internal/outbox: off unless a dispatch secret is set,
 * bearer-authenticated, 404 rather than 403 so an unset secret does not
 * advertise the endpoint. It sweeps stranded leases first, so a worker that
 * died between claim and completion is retried by the next tick rather than
 * waiting for its lease to be noticed.
 *
 * Two callers exist and both are supported here:
 *   - an operator or local script, sending OUTBOX_DISPATCH_SECRET as POST;
 *   - Vercel Cron, which issues GET and signs with CRON_SECRET. It does not
 *     send our own header, which is why GET is exported separately rather than
 *     the schedule silently 405-ing every night (ASH-189).
 *
 * Deployed, this is only as useful as the plan's cron cadence: Vercel's free
 * plan runs crons at most daily, which is what vercel.json schedules. Locally
 * the worker (`make queue-up`) is the trigger.
 *
 * Reconciliation follows the drain in the same pass. An UNKNOWN attempt is a
 * send the provider never answered, and it blocks its proposal until someone
 * asks the provider what happened; riding the same tick is what turns that from
 * a manual repair into a background fact. It settles nothing on a guess, so a
 * slow provider degrades to "still unknown" rather than a wrong answer.
 */

function secrets(): string[] {
  // Trimmed on both sides of the comparison: a secret pasted with a trailing
  // newline is a normal operator mistake, and it must not present as an opaque
  // 401 that looks like a wrong secret.
  return [process.env.OUTBOX_DISPATCH_SECRET, process.env.CRON_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function authorized(request: Request, candidates: string[]): boolean {
  const presented = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (presented.length === 0) return false;
  const a = Buffer.from(presented);
  return candidates.some((secret) => {
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function drain(): Promise<Response> {
  const client = postgres(process.env.DATABASE_URL ?? "", { max: 1, debug: rawQueryDebugger });
  try {
    const recovered = await withQueryLog("cron.recover_stranded", () => recoverStrandedOutbox(client));
    const result = await withQueryLog("cron.dispatch", () =>
      dispatchPendingOutbox(client, outboxHandlers(), { workerId: `cron:${crypto.randomUUID()}` }),
    );
    // The superagent domain's drain rides the same tick: the sweep first
    // (the engine's serverless tick — start due evals, which is what
    // enqueues the assessment effects — plus the ticket-run observer), then
    // the effects pass (whose reply handlers send the reply lane). The free
    // plan's daily cron cannot be relied on for latency, which is why the
    // inline post-commit drain is the primary trigger.
    await withQueryLog("cron.superagent_sweep", () => sweepSuperagentWorkspaces());
    const superagent = await withQueryLog("cron.superagent_dispatch", async () =>
      runSuperagentDispatch(client, await superagentEffectHandlers(), {
        workerId: `cron:${crypto.randomUUID()}`,
      }),
    );
    // After the drain: a send that just went UNKNOWN is too young to reconcile,
    // and the row it left is why this runs at all.
    const reconciliation = await withQueryLog("cron.reconcile_attempts", () =>
      reconcileUnknownAttempts({ transport: composioTransport }),
    );
    // The Instant catalog heals daily: toolkits Composio added appear, retired
    // ones stop being offered. An outage here must not break the rest of the
    // cron's work — the bootstrap migration already seeded the catalog.
    let instantSync: { upserted: number; deactivated: number } | { error: string } | null = null;
    if (process.env.COMPOSIO_API_KEY) {
      try {
        instantSync = await InstantTools.syncInstantCatalog({ apiKey: process.env.COMPOSIO_API_KEY });
      } catch (cause) {
        instantSync = { error: cause instanceof Error ? cause.message : "unknown error" };
      }
    }
    // ASH-287: opted-in Gmail accounts get new-sender contact proposals. A provider
    // outage here must not break the rest of the pass; each account reports its own failure.
    let senderSync: Awaited<ReturnType<typeof syncAllGmailSenders>> | { error: string };
    try {
      senderSync = await syncAllGmailSenders(composioTransport);
    } catch (cause) {
      senderSync = { error: cause instanceof Error ? cause.message : "unknown error" };
    }
    // Stranded quota reservations: a process that died between reserve and
    // settle/release holds bucket units until the period rolls (forever for a
    // lifetime grant). Reaping here rides the same tick that recovers stranded
    // outbox leases; a failure must not break the rest of the pass.
    let quotaReap: { reaped: number } | { error: string } | null = null;
    try {
      quotaReap = { reaped: await reapStaleReservations() };
    } catch (cause) {
      quotaReap = { error: cause instanceof Error ? cause.message : "unknown error" };
    }
    // The polling fact deck refreshes monthly: one dispatch key per month makes
    // every pass after the first a no-op, and the handler's uniqueness absorbs
    // a redelivery. A failure must not break the rest of the pass.
    let factRefresh: { enqueued: boolean } | { error: string };
    try {
      factRefresh = await scheduleMonthlyFactRefresh();
    } catch (cause) {
      factRefresh = { error: cause instanceof Error ? cause.message : "unknown error" };
    }
    // Each workspace gets one Tidy pass a day: the dispatch key carries the
    // workspace and the UTC date, so later ticks that day enqueue nothing. A
    // failure must not break the rest of the pass.
    let tidySchedule: { enqueued: number } | { error: string };
    try {
      tidySchedule = await scheduleDailyTidyPasses();
    } catch (cause) {
      tidySchedule = { error: cause instanceof Error ? cause.message : "unknown error" };
    }
    // One dreaming pass per owner per day: reads recent transcripts, checks
    // the notes against them, and maintains the small injected index. Same
    // dispatch-key discipline as Tidy, so later ticks that day enqueue nothing.
    let memoryDreams: { enqueued: number } | { error: string };
    try {
      memoryDreams = await scheduleDailyMemoryDreams();
    } catch (cause) {
      memoryDreams = { error: cause instanceof Error ? cause.message : "unknown error" };
    }
    return Response.json({
      recovered: recovered.length,
      ...result,
      superagent,
      reconciled: reconciliation.reconciled,
      instantSync,
      senderSync,
      quotaReap,
      factRefresh,
      tidySchedule,
      memoryDreams,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export async function POST(request: Request) {
  const candidates = secrets();
  if (candidates.length === 0) return problemResponse(404, "not_found", "Not found.");
  if (!authorized(request, candidates)) return problemResponse(401, "unauthorized", "Unauthorized.");
  return drain();
}

/** Vercel Cron entry point. Same work, same gate. */
export async function GET(request: Request) {
  return POST(request);
}
