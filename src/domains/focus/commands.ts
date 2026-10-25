import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { captures } from "@/domains/capture/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { tasks } from "@/domains/work/schema";
import { focusSessions } from "./schema";

/*
 * Focus session lifecycle (ASH-137 A09). The server clock is authoritative:
 * elapsed time is accumulatedSeconds plus, while running, the time since
 * lastResumedAt (or startedAt). A pause banks the running stretch into
 * accumulatedSeconds; a finish banks it and closes. A client timer only ever
 * displays this state - a refresh, a navigation, or a second tab resumes the
 * same session instead of starting a rival one.
 *
 * At most one session is live (running or paused) per workspace; the partial
 * unique index focus_sessions_active_idx is the real guard, so two tabs
 * racing a start get one session and one conflict, never two sessions.
 * Every transition re-checks both the expected version and the state it
 * moves from, so a retried or double-clicked action is a stale-write error,
 * not a duplicate pause entry or a resurrected session.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

function isUniqueViolation(cause: unknown): boolean {
  return (cause as { cause?: { code?: string } })?.cause?.code === "23505";
}

export async function startFocusSession(
  auth: AuthContext,
  input: { taskId?: string | null; subject?: string | null; plannedMinutes?: number | null },
) {
  try {
    return await withTransaction(async (tx) => {
      if (input.taskId) {
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
          .limit(1);
        if (!task) throw new ConflictError("That task does not exist in this workspace.");
      }
      const [session] = await tx
        .insert(focusSessions)
        .values({
          workspaceId: auth.workspaceId,
          taskId: input.taskId ?? null,
          subject: input.subject ?? null,
          plannedMinutes: input.plannedMinutes ?? null,
          state: "running",
          startedAt: new Date(),
          lastResumedAt: new Date(),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "focus_session.started",
          subjectType: "focus_session",
          subjectId: session.id,
          summary: session.subject ? `Focus started: ${session.subject}` : "Focus started",
        },
        tx,
      );
      return session;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A focus session is already running. Finish or abandon it first.");
    }
    throw cause;
  }
}

type LiveTransition = {
  sessionId: string;
  expectedVersion: number;
  reason?: string | null;
  outcome?: string | null;
  whatChanged?: string | null;
  nextStep?: string | null;
};

/*
 * One guarded UPDATE per transition. The WHERE clause carries the expected
 * version and the states the transition is allowed from; zero rows back
 * means the session moved on since the caller looked, which is a stale write.
 */
async function transition(
  auth: AuthContext,
  input: LiveTransition,
  fromStates: Array<"running" | "paused">,
  patch: (now: Date) => Record<string, unknown>,
  audit: { action: string; summary: string },
) {
  return withTransaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(focusSessions)
      .set({
        ...patch(now),
        version: sql`${focusSessions.version} + 1`,
        updatedAt: now,
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.workspaceId, auth.workspaceId),
          eq(focusSessions.version, input.expectedVersion),
          sql`${focusSessions.state} in (${sql.join(fromStates.map((s) => sql`${s}`), sql`, `)})`,
          // Lifecycle transitions move time, so they require a session that
          // started: a planned row (started_at null, ASH-308) can only be
          // started, dismissed, or left alone - never paused, resumed,
          // finished, or abandoned.
          isNotNull(focusSessions.startedAt),
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The focus session changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: audit.action, subjectType: "focus_session", subjectId: updated.id, summary: audit.summary },
      tx,
    );
    return updated;
  });
}

/* Interruption log entries: [{ at, reason }] per the schema contract. */
const logEntry = (at: Date, reason: string) =>
  sql`coalesce(${focusSessions.interruptions}, '[]'::jsonb) || ${JSON.stringify([{ at: at.toISOString(), reason }])}::jsonb`;

export async function pauseFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["running"],
    (now) => ({
      state: "paused",
      // Bank the running stretch: from the last resume (or start) to now.
      accumulatedSeconds: sql`${focusSessions.accumulatedSeconds} + floor(extract(epoch from (${now.toISOString()}::timestamptz - coalesce(${focusSessions.lastResumedAt}, ${focusSessions.startedAt}))))::int`,
      interruptions: logEntry(now, input.reason?.trim() || "paused"),
    }),
    { action: "focus_session.paused", summary: "Focus paused" },
  );
}

export async function resumeFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["paused"],
    (now) => ({
      state: "running",
      lastResumedAt: now,
      interruptions: logEntry(now, "resumed"),
    }),
    { action: "focus_session.resumed", summary: "Focus resumed" },
  );
}

export async function finishFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["running", "paused"],
    (now) => ({
      state: "finished",
      endedAt: now,
      outcome: input.outcome?.trim() || null,
      whatChanged: input.whatChanged?.trim() || null,
      nextStep: input.nextStep?.trim() || null,
      // A finish from running banks the open stretch; from paused, nothing is open.
      accumulatedSeconds: sql`${focusSessions.accumulatedSeconds} + case when ${focusSessions.state} = 'running' then floor(extract(epoch from (${now.toISOString()}::timestamptz - coalesce(${focusSessions.lastResumedAt}, ${focusSessions.startedAt}))))::int else 0 end`,
    }),
    { action: "focus_session.finished", summary: "Focus finished" },
  );
}

export async function abandonFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["running", "paused"],
    (now) => ({
      state: "abandoned",
      endedAt: now,
      outcome: input.reason?.trim() || null,
    }),
    { action: "focus_session.abandoned", summary: "Focus abandoned" },
  );
}

/*
 * ASH-308: a capture dropped on a theatre slot becomes a planned session.
 * "Planned" is derived - scheduledAt set, startedAt null. The ticket forbids
 * an enum change, so the row borrows state 'paused' and is told apart from a
 * real paused session by its columns: a real pause always has startedAt and
 * never has an un-started scheduledAt. The capture row is never mutated; the
 * session points at it. The drag's idempotency key is a request receipt: a
 * double-drop replays the first session, never creates a second one.
 */
export async function scheduleSessionFromCapture(
  auth: AuthContext,
  input: { captureId: string; scheduledAt: Date; idempotencyKey?: string },
) {
  if (!(input.scheduledAt instanceof Date) || Number.isNaN(input.scheduledAt.getTime())) {
    throw new ConflictError("That slot is not a time.");
  }
  if (input.scheduledAt.getTime() < Date.now() - 60_000) {
    throw new ConflictError("That slot has already passed.");
  }
  return withTransaction(async (tx) => {
    const [capture] = await tx
      .select({ id: captures.id, title: captures.title })
      .from(captures)
      .where(and(eq(captures.id, input.captureId), eq(captures.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!capture) throw new ConflictError("That capture does not exist in this workspace.");

    const { value, replayed } = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { captureId: input.captureId, scheduledAt: input.scheduledAt.toISOString() },
      async () => {
        const [session] = await tx
          .insert(focusSessions)
          .values({
            workspaceId: auth.workspaceId,
            captureId: capture.id,
            subject: capture.title,
            // Borrowed, not meaningful: the enum cannot grow (ticket constraint).
            // Every read that matters derives "planned" from the columns.
            state: "paused",
            scheduledAt: input.scheduledAt,
            // The durable clock starts when the session does, not when it is planned.
            startedAt: null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning();
        await recordAudit(
          auth,
          {
            action: "focus.session_scheduled",
            subjectType: "focus_session",
            subjectId: session.id,
            summary: `Scheduled: ${session.subject ?? "capture"} at ${input.scheduledAt.toISOString()}`,
          },
          tx,
        );
        return { sessionId: session.id };
      },
    );
    return { sessionId: value.sessionId, replayed };
  });
}

/*
 * Dismissing a scheduled block deletes the row: it never ran, so there is
 * nothing to preserve. Only a not-yet-started scheduled row can go - a
 * started session belongs to the lifecycle transitions above.
 */
export async function unscheduleFocusSession(auth: AuthContext, input: { sessionId: string }) {
  return withTransaction(async (tx) => {
    const [removed] = await tx
      .delete(focusSessions)
      .where(
        and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.workspaceId, auth.workspaceId),
          eq(focusSessions.state, "paused"),
          isNull(focusSessions.startedAt),
          isNotNull(focusSessions.scheduledAt),
        ),
      )
      .returning({ id: focusSessions.id, subject: focusSessions.subject });
    if (!removed) {
      throw new StaleWriteError("That scheduled session changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: "focus.session_unscheduled", subjectType: "focus_session", subjectId: removed.id, summary: `Unscheduled: ${removed.subject ?? "capture"}` },
      tx,
    );
    return { sessionId: removed.id };
  });
}

/*
 * scheduled -> started: the existing start flow takes over, but it takes over
 * THIS row - the planned session becomes the live one rather than spawning a
 * rival. Same guards as any start: one live session per workspace.
 */
export async function startScheduledFocusSession(auth: AuthContext, input: { sessionId: string; expectedVersion: number }) {
  try {
    return await withTransaction(async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(focusSessions)
        .set({
          state: "running",
          startedAt: now,
          lastResumedAt: now,
          version: sql`${focusSessions.version} + 1`,
          updatedAt: now,
          updatedBy: auth.userId,
        })
        .where(
          and(
            eq(focusSessions.id, input.sessionId),
            eq(focusSessions.workspaceId, auth.workspaceId),
            eq(focusSessions.version, input.expectedVersion),
            eq(focusSessions.state, "paused"),
            isNull(focusSessions.startedAt),
            isNotNull(focusSessions.scheduledAt),
          ),
        )
        .returning();
      if (!updated) {
        throw new StaleWriteError("That scheduled session changed since you loaded it. Reload and try again.");
      }
      await recordAudit(
        auth,
        { action: "focus_session.started", subjectType: "focus_session", subjectId: updated.id, summary: updated.subject ? `Focus started: ${updated.subject}` : "Focus started" },
        tx,
      );
      return updated;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A focus session is already running. Finish or abandon it first.");
    }
    throw cause;
  }
}
