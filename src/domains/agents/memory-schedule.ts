import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { enqueueOutbox } from "@/domains/audit/outbox";
import type { AuthContext } from "@/domains/identity/resolve";
import { memberships } from "@/domains/identity/schema";
import { workspaces } from "@/domains/identity/tables";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { MEMORY_DREAM_TOPIC } from "./memory-dreaming";

/*
 * The scheduler half of dreaming. One pass per active owner per UTC day, on
 * the same daily cron tick the Tidy pass rides. The dispatch key carries the
 * workspace, the user and the date, so every later tick that day enqueues
 * nothing — the cron is free to run more than once.
 *
 * Only owners are scheduled: memory is per person, and a member's transcripts
 * are not the owner's to consolidate. A workspace with several owners gets
 * one pass each, because each owns their own notes.
 */

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function scheduleDailyMemoryDreams(now: Date = new Date()): Promise<{ enqueued: number }> {
  const owners = await db
    .select({ workspaceId: memberships.workspaceId, userId: memberships.userId })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.role, "owner"),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
        isNotNull(memberships.userId),
      ),
    )
    .orderBy(asc(memberships.workspaceId), asc(memberships.createdAt));
  if (owners.length === 0) return { enqueued: 0 };
  const day = utcDay(now);
  let enqueued = 0;
  await withTransaction(async (tx) => {
    for (const owner of owners) {
      const result = await enqueueOutbox(
        tx,
        { workspaceId: owner.workspaceId },
        {
          topic: MEMORY_DREAM_TOPIC,
          payload: { userId: owner.userId, day },
          dispatchKey: `memory-dream:${owner.workspaceId}:${owner.userId}:${day}`,
        },
      );
      if (result.enqueued) enqueued += 1;
    }
  });
  return { enqueued };
}

/**
 * The owner asking for a pass now, rather than waiting for tomorrow's. The
 * dispatch key carries a random suffix on purpose: a hand-triggered pass is
 * the person's explicit request and must not be swallowed as already-done.
 */
export async function requestMemoryDreamNow(auth: AuthContext): Promise<{ enqueued: boolean }> {
  const result = await withTransaction((tx) =>
    enqueueOutbox(tx, auth, {
      topic: MEMORY_DREAM_TOPIC,
      payload: { userId: auth.userId, requested: "manual" },
      dispatchKey: `memory-dream-now:${auth.workspaceId}:${auth.userId}:${crypto.randomUUID()}`,
    }),
  );
  return { enqueued: result.enqueued };
}
