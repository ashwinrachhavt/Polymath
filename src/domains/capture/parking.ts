import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { enqueueOutbox } from "@/domains/audit/outbox";
import { outboxEvents } from "@/domains/audit/schema";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { CAPTURE_ENRICHMENT_TOPIC, CAPTURE_URL_CONTENT_TOPIC, StaleWriteError } from "./commands";
import { captures } from "./schema";

/*
 * Parking (ASH-305): "set this aside, I will come back". It is a flag on its
 * own axis (captures.parked_at), never a processing_state, because the states
 * are written by background handlers: a parked state could be overwritten by an
 * in-flight enrichment, and unparking to "unprocessed" would discard an
 * enriched reading and re-run paid classification.
 *
 * What parking PAUSES (each reads parked_at):
 *  - the owner's to-clarify queue and its count (capture/queries.ts);
 *  - the home queue's classification suggestions for the capture (home/queue.ts);
 *  - zettel source selection and the zettel handler (capture/zettel-generation.ts);
 *  - NEW enrichment and URL-content work: the handlers return early, so no new
 *    model call, fetch or proposal is produced for a parked capture.
 * What parking LETS FINISH: work already past the handler's entry check (an
 * enrichment mid-flight writes its result and any proposal as it would have;
 * the proposal stays hidden from the queue until unpark). Nothing is deleted
 * or rewritten: processing_state, text, proposals and lineage are untouched.
 * Explicit owner actions on the capture (edit, convert, archive) still work
 * from the Parked view; they are the owner's own decision, not background work.
 *
 * Unpark clears the flag. A capture whose enrichment was skipped while parked
 * (still unprocessed/classifying) gets its work re-queued under a key tied to
 * the unpark version, so the paused work runs exactly once; an enriched capture
 * re-queues nothing.
 */

const PARKABLE = ["unprocessed", "classifying", "enriched", "failed"] as const;

export type ParkInput = { captureId: string; expectedVersion: number };

export async function parkCaptureInTx(tx: TxDrizzle, auth: AuthContext, input: ParkInput) {
  const now = new Date();
  const [updated] = await tx
    .update(captures)
    .set({
      parkedAt: now,
      parkedBy: auth.userId,
      version: sql`${captures.version} + 1`,
      updatedAt: now,
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(captures.workspaceId, auth.workspaceId),
        eq(captures.id, input.captureId),
        eq(captures.version, input.expectedVersion),
        isNull(captures.parkedAt),
        isNull(captures.archivedAt),
        inArray(captures.processingState, [...PARKABLE]),
      ),
    )
    .returning();
  if (!updated) throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
  await recordAudit(
    auth,
    { action: "capture.parked", subjectType: "capture", subjectId: updated.id, summary: "Capture parked" },
    tx,
  );
  return updated;
}

export async function unparkCaptureInTx(tx: TxDrizzle, auth: AuthContext, input: ParkInput) {
  const now = new Date();
  const [updated] = await tx
    .update(captures)
    .set({
      parkedAt: null,
      parkedBy: null,
      version: sql`${captures.version} + 1`,
      updatedAt: now,
      updatedBy: auth.userId,
    })
    .where(
      and(
        eq(captures.workspaceId, auth.workspaceId),
        eq(captures.id, input.captureId),
        eq(captures.version, input.expectedVersion),
        sql`${captures.parkedAt} is not null`,
      ),
    )
    .returning();
  if (!updated) throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");

  // Resume work the park skipped. Only a capture still waiting on enrichment
  // has any; an enriched, converted or failed one is left exactly as it was.
  // A SUPPRESSED event (a handler saw the park and returned) is already
  // dispatched and gone, so its work is re-queued; a still-PENDING, unclaimed
  // event is not duplicated - it will run now that the flag is clear. A
  // claimed event may already have returned early, so it does not count as
  // pending work; if both then run, the handler's own state guard makes the
  // second a no-op once the first has moved the capture past 'unprocessed'.
  if (updated.processingState === "unprocessed" || updated.processingState === "classifying") {
    const waiting = async (topic: string) => {
      const [row] = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.workspaceId, auth.workspaceId),
            eq(outboxEvents.topic, topic),
            eq(outboxEvents.status, "pending"),
            isNull(outboxEvents.leaseOwner),
            sql`${outboxEvents.payload}->>'captureId' = ${updated.id}`,
          ),
        )
        .limit(1);
      return Boolean(row);
    };
    if (updated.url && !updated.text && !(await waiting(CAPTURE_URL_CONTENT_TOPIC))) {
      await enqueueOutbox(tx, auth, {
        topic: CAPTURE_URL_CONTENT_TOPIC,
        payload: { captureId: updated.id, url: updated.url },
        dispatchKey: `capture-url-content:${updated.id}:unpark-v${updated.version}`,
      });
    }
    if (!(await waiting(CAPTURE_ENRICHMENT_TOPIC))) {
      await enqueueOutbox(tx, auth, {
        topic: CAPTURE_ENRICHMENT_TOPIC,
        payload: { captureId: updated.id },
        dispatchKey: `capture-enrichment:${updated.id}:unpark-v${updated.version}`,
      });
    }
  }
  await recordAudit(
    auth,
    { action: "capture.unparked", subjectType: "capture", subjectId: updated.id, summary: "Capture unparked" },
    tx,
  );
  return updated;
}

export const parkCapture = (auth: AuthContext, input: ParkInput) =>
  withTransaction((tx) => parkCaptureInTx(tx, auth, input));

export const unparkCapture = (auth: AuthContext, input: ParkInput) =>
  withTransaction((tx) => unparkCaptureInTx(tx, auth, input));
