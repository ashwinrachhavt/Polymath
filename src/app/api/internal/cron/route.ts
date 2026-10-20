import postgres from "postgres";
import { timingSafeEqual } from "node:crypto";
import { dispatchPendingOutbox, recoverStrandedOutbox } from "@/domains/audit/outbox";
import { outboxHandlers } from "@/domains/audit/outbox-handlers";
import { problemResponse } from "@/lib/problems";

/*
 * POST /api/internal/cron - one dispatcher pass, for a scheduler.
 *
 * Same contract as /api/internal/outbox: off unless OUTBOX_DISPATCH_SECRET is
 * set, bearer-authenticated, 404 rather than 403 so an unset secret does not
 * advertise the endpoint. It sweeps stranded leases first, so a worker that
 * died between claim and completion is retried by the next tick rather than
 * waiting for its lease to be noticed.
 *
 * Deployed, this is only as useful as the plan's cron cadence: Vercel's free
 * plan runs crons at most daily, which is why extraction on a deployed box is
 * documented as manual. Locally the worker (`make queue-up`) is the trigger.
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

  const client = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
  try {
    const recovered = await recoverStrandedOutbox(client);
    const result = await dispatchPendingOutbox(client, outboxHandlers(client), { workerId: `cron:${crypto.randomUUID()}` });
    return Response.json({ recovered: recovered.length, ...result });
  } finally {
    await client.end({ timeout: 5 });
  }
}
