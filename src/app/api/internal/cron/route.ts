import postgres from "postgres";
import { timingSafeEqual } from "node:crypto";
import { reconcileUnknownAttempts } from "@/domains/actions/reconciliation";
import { dispatchPendingOutbox, recoverStrandedOutbox } from "@/domains/audit/outbox";
import { outboxHandlers } from "@/domains/audit/outbox-handlers";
import { composioTransport } from "@/domains/integrations/transport";
import { problemResponse } from "@/lib/problems";

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
  const client = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
  try {
    const recovered = await recoverStrandedOutbox(client);
    const result = await dispatchPendingOutbox(client, outboxHandlers(), { workerId: `cron:${crypto.randomUUID()}` });
    // After the drain: a send that just went UNKNOWN is too young to reconcile,
    // and the row it left is why this runs at all.
    const reconciliation = await reconcileUnknownAttempts({ transport: composioTransport });
    return Response.json({ recovered: recovered.length, ...result, reconciled: reconciliation.reconciled });
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
