import { and, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { tasks } from "@/domains/work/schema";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { calendars, eventLinks, events, schedulerPreferences } from "./schema";
import { findFreeSlot } from "./slots";

/*
 * Calendar writes for the owner and for agents (ASH-185). Time blocks are
 * ordinary local events linked to a task through event_links, so the week view,
 * agents and a later provider sync all read one table. Every command is one
 * transaction with an optional idempotency key and a version compare-and-set.
 */

export class EventNotFoundError extends Error {
  readonly code = "event_not_found";
  constructor() {
    super("That event does not exist in this workspace.");
  }
}
export class EventVersionConflictError extends Error {
  readonly code = "event_version_conflict";
  constructor() {
    super("This event changed since you loaded it. Reload and try again.");
  }
}
export class InvalidRangeError extends Error {
  readonly code = "invalid_range";
  constructor() {
    super("An event must end after it starts, and last under 24 hours.");
  }
}
export class NoFreeSlotError extends Error {
  readonly code = "no_free_slot";
  constructor() {
    super("No free slot fits in the next two weeks of working hours.");
  }
}

type Keyed = { idempotencyKey?: string };
const MAX_MS = 24 * 60 * 60_000;

function checkRange(start: Date, end: Date) {
  const span = end.getTime() - start.getTime();
  if (!(span > 0) || span >= MAX_MS) throw new InvalidRangeError();
}

/** The workspace's local calendar, created on first use. */
export async function ensureLocalCalendar(tx: TxDrizzle, auth: AuthContext): Promise<string> {
  const [row] = await tx
    .insert(calendars)
    .values({
      workspaceId: auth.workspaceId,
      kind: "local",
      name: "Polymath",
      isPrimary: true,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoNothing({ target: [calendars.workspaceId, calendars.name] })
    .returning({ id: calendars.id });
  if (row) return row.id;
  const [existing] = await tx
    .select({ id: calendars.id })
    .from(calendars)
    .where(and(eq(calendars.workspaceId, auth.workspaceId), eq(calendars.name, "Polymath")))
    .limit(1);
  return existing.id;
}

export async function createEvent(
  auth: AuthContext,
  input: Keyed & { title: string; startsAt: Date; endsAt: Date; description?: string; taskId?: string },
): Promise<{ id: string; version: number }> {
  checkRange(input.startsAt, input.endsAt);
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "createEvent", ...input }, async () => {
      if (input.taskId) {
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
          .limit(1);
        if (!task) throw new Error("task not found in workspace");
      }
      const calendarId = await ensureLocalCalendar(tx, auth);
      const [row] = await tx
        .insert(events)
        .values({
          workspaceId: auth.workspaceId,
          calendarId,
          title: input.title,
          description: input.description ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: events.id, version: events.version });
      if (input.taskId) {
        await tx.insert(eventLinks).values({
          workspaceId: auth.workspaceId,
          eventId: row.id,
          targetType: "task",
          targetId: input.taskId,
          label: "Time block",
        });
      }
      await recordAudit(
        auth,
        {
          action: input.taskId ? "event.time_blocked" : "event.created",
          subjectType: "event",
          subjectId: row.id,
          summary: `${input.taskId ? "Blocked time for" : "Created event"} "${input.title}"`,
          metadata: { taskId: input.taskId ?? null },
        },
        tx,
      );
      return { id: row.id, version: row.version };
    });
    return value;
  });
}

export async function moveEvent(
  auth: AuthContext,
  input: Keyed & { eventId: string; expectedVersion: number; startsAt: Date; endsAt: Date; title?: string },
): Promise<{ id: string; version: number }> {
  checkRange(input.startsAt, input.endsAt);
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "moveEvent", ...input }, async () => {
      const [row] = await tx
        .update(events)
        .set({
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          ...(input.title ? { title: input.title } : {}),
          updatedAt: new Date(),
          updatedBy: auth.userId,
          version: sql`${events.version} + 1`,
        })
        .where(
          and(
            eq(events.id, input.eventId),
            eq(events.workspaceId, auth.workspaceId),
            eq(events.version, input.expectedVersion),
            isNull(events.archivedAt),
          ),
        )
        .returning({ id: events.id, version: events.version, title: events.title });
      if (!row) {
        const [exists] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, input.eventId), eq(events.workspaceId, auth.workspaceId), isNull(events.archivedAt)))
          .limit(1);
        throw exists ? new EventVersionConflictError() : new EventNotFoundError();
      }
      await recordAudit(
        auth,
        { action: "event.moved", subjectType: "event", subjectId: row.id, summary: `Moved "${row.title}"` },
        tx,
      );
      return { id: row.id, version: row.version };
    });
    return value;
  });
}

/** Cancelling archives the row: history stays, the week view stops showing it. */
export async function cancelEvent(
  auth: AuthContext,
  input: Keyed & { eventId: string; expectedVersion: number },
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "cancelEvent", ...input }, async () => {
      const [row] = await tx
        .update(events)
        .set({
          status: "cancelled",
          archivedAt: new Date(),
          updatedAt: new Date(),
          updatedBy: auth.userId,
          version: sql`${events.version} + 1`,
        })
        .where(
          and(
            eq(events.id, input.eventId),
            eq(events.workspaceId, auth.workspaceId),
            eq(events.version, input.expectedVersion),
            isNull(events.archivedAt),
          ),
        )
        .returning({ id: events.id, title: events.title });
      if (!row) {
        const [exists] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, input.eventId), eq(events.workspaceId, auth.workspaceId), isNull(events.archivedAt)))
          .limit(1);
        throw exists ? new EventVersionConflictError() : new EventNotFoundError();
      }
      await recordAudit(
        auth,
        { action: "event.cancelled", subjectType: "event", subjectId: row.id, summary: `Cancelled "${row.title}"` },
        tx,
      );
      return { id: row.id };
    });
    return value;
  });
}

/**
 * Time-block a task in the first free working-hours gap. The agent-facing
 * entry point: "find time for this" without the caller reading the calendar.
 */
export async function blockTimeForTask(
  auth: AuthContext,
  input: Keyed & { taskId: string; minutes?: number; from?: Date; utcOffsetMinutes?: number },
): Promise<{ id: string; version: number; startsAt: string; endsAt: string }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "blockTimeForTask", ...input }, async () => {
      const [task] = await tx
        .select({ id: tasks.id, title: tasks.title, estimateMinutes: tasks.estimateMinutes })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
        .limit(1);
      if (!task) throw new Error("task not found in workspace");
      const minutes = input.minutes ?? task.estimateMinutes ?? 30;
      const from = input.from ?? new Date();

      // Serialize concurrent blockers so two agents cannot book the same gap.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cal:${auth.workspaceId}`}, 0))`);
      const [prefs] = await tx
        .select()
        .from(schedulerPreferences)
        .where(eq(schedulerPreferences.workspaceId, auth.workspaceId))
        .limit(1);
      const horizon = new Date(from.getTime() + 15 * 86_400_000);
      const busyRows = await tx
        .select({ start: events.startsAt, end: events.endsAt })
        .from(events)
        .where(
          and(
            eq(events.workspaceId, auth.workspaceId),
            isNull(events.archivedAt),
            ne(events.status, "cancelled"),
            lt(events.startsAt, horizon),
            gt(events.endsAt, from),
          ),
        );
      const slot = findFreeSlot({
        from,
        minutes,
        busy: busyRows.map((b) => ({ start: b.start, end: b.end })),
        earliestMinute: prefs?.earliestMinute,
        latestMinute: prefs?.latestMinute,
        bufferMinutes: prefs?.bufferMinutes,
        utcOffsetMinutes: input.utcOffsetMinutes,
      });
      if (!slot) throw new NoFreeSlotError();

      const calendarId = await ensureLocalCalendar(tx, auth);
      const [row] = await tx
        .insert(events)
        .values({
          workspaceId: auth.workspaceId,
          calendarId,
          title: task.title,
          startsAt: slot.start,
          endsAt: slot.end,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: events.id, version: events.version });
      await tx.insert(eventLinks).values({
        workspaceId: auth.workspaceId,
        eventId: row.id,
        targetType: "task",
        targetId: task.id,
        label: "Time block",
      });
      await recordAudit(
        auth,
        {
          action: "event.time_blocked",
          subjectType: "event",
          subjectId: row.id,
          summary: `Blocked time for "${task.title}"`,
          metadata: { taskId: task.id, minutes },
        },
        tx,
      );
      return { id: row.id, version: row.version, startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString() };
    });
    return value;
  });
}
