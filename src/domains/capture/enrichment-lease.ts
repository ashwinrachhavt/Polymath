import { and, eq, inArray, sql } from "drizzle-orm";
import { OutboxParkError, type ClaimedOutboxEvent } from "@/domains/audit/outbox";
import { db } from "@/lib/db";
import { captures } from "./schema";

/*
 * ASH-305: the fenced, time-boxed claim on a capture's background work. Both
 * enrichment and URL-content fetching take it before any provider call, so a
 * claimed run and an unpark re-queue (or the two topics against each other)
 * cannot both pay for the same work.
 *
 * Longest honest run: transcription (60s) + Jev (30s) + generation fallback
 * (30s) = 120s of provider time, so 5 minutes clears it with margin. A crashed
 * run blocks its redelivery for at most this long. A run that outlives the
 * lease is fenced out, not trusted: its writes match no row and it stops. That
 * bounds duplicate paid calls to the expiry case; it is not exactly-once
 * across expiry.
 */
export const ENRICHMENT_LEASE_MS = 5 * 60_000;
/** How often a run that found the lease busy looks again: short, so finished work is picked up promptly. */
export const BUSY_RECHECK_MS = 30_000;

export const RELEASE = { enrichmentLeaseToken: null, enrichmentLeaseUntil: null } as const;

export class EnrichmentLeaseLostError extends Error {
  constructor() {
    super("enrichment lease lost");
    this.name = "EnrichmentLeaseLostError";
  }
}

/**
 * Take the lease, or say why not: a capture already past the queue or parked
 * returns null (nothing to do; unpark re-queues parked work), and a live lease
 * throws OutboxParkError, which the dispatcher turns into a re-look without
 * spending an attempt, so a busy capture never dead-letters the event.
 */
export async function acquireEnrichmentLease(
  event: ClaimedOutboxEvent,
  capture: { id: string },
): Promise<string | null> {
  const token = crypto.randomUUID();
  const acquired = await db
    .update(captures)
    .set({ enrichmentLeaseToken: token, enrichmentLeaseUntil: new Date(Date.now() + ENRICHMENT_LEASE_MS) })
    .where(
      and(
        eq(captures.id, capture.id),
        eq(captures.workspaceId, event.workspaceId),
        inArray(captures.processingState, ["unprocessed", "classifying"]),
        sql`${captures.parkedAt} is null`,
        sql`(${captures.enrichmentLeaseUntil} is null or ${captures.enrichmentLeaseUntil} <= now())`,
      ),
    )
    .returning({ id: captures.id });
  if (acquired.length > 0) return token;

  const [now] = await db.select().from(captures).where(eq(captures.id, capture.id)).limit(1);
  if (!now || (now.processingState !== "unprocessed" && now.processingState !== "classifying") || now.parkedAt) {
    return null;
  }
  const remaining = (now.enrichmentLeaseUntil?.getTime() ?? Date.now()) - Date.now();
  throw new OutboxParkError(Math.min(Math.max(remaining + 1000, 5000), BUSY_RECHECK_MS), "capture is being enriched");
}

/** A write by the lease holder only; zero rows means someone else holds or finished the capture. */
export async function ownedUpdate(token: string, captureId: string, set: Partial<typeof captures.$inferInsert>) {
  const rows = await db
    .update(captures)
    .set(set)
    .where(and(eq(captures.id, captureId), eq(captures.enrichmentLeaseToken, token)))
    .returning({ id: captures.id });
  if (rows.length === 0) throw new EnrichmentLeaseLostError();
}

/** Free the claim after a failed attempt; token-matched, so a lost lease is a no-op. */
export async function releaseEnrichmentLease(token: string, captureId: string) {
  await db
    .update(captures)
    .set(RELEASE)
    .where(and(eq(captures.id, captureId), eq(captures.enrichmentLeaseToken, token)));
}
