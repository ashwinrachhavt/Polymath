import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { focusSessions } from "./schema";

/*
 * Read queries for the focus surface (ASH-137 A09). Elapsed time is derived
 * from the durable clock fields at read: accumulatedSeconds plus, while
 * running, the time since lastResumedAt (or startedAt). Nothing stores a
 * computed elapsed value, so a reload always agrees with the server.
 */

export type FocusSessionView = typeof focusSessions.$inferSelect & {
  /** Seconds of real elapsed focus, computed at read. */
  elapsedSeconds: number;
};

export function withElapsed(session: typeof focusSessions.$inferSelect, now = new Date()): FocusSessionView {
  // startedAt is null while a session is only scheduled (ASH-308); a running
  // session always has the clock fields.
  const clockStart = session.lastResumedAt ?? session.startedAt;
  const openStretch =
    session.state === "running" && clockStart
      ? Math.max(0, Math.floor((now.getTime() - clockStart.getTime()) / 1000))
      : 0;
  return { ...session, elapsedSeconds: session.accumulatedSeconds + openStretch };
}

/** The one live session (running or paused), or null. */
export async function getActiveFocusSession(auth: AuthContext): Promise<FocusSessionView | null> {
  const [session] = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.workspaceId, auth.workspaceId),
        inArray(focusSessions.state, ["running", "paused"]),
        isNull(focusSessions.archivedAt),
      ),
    )
    .limit(1);
  return session ? withElapsed(session) : null;
}

/** Closed sessions, newest first. */
export async function listFocusHistory(auth: AuthContext, limit = 30, taskId?: string): Promise<FocusSessionView[]> {
  const rows = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.workspaceId, auth.workspaceId),
        inArray(focusSessions.state, ["finished", "abandoned", "interrupted"]),
        isNull(focusSessions.archivedAt),
        taskId ? eq(focusSessions.taskId, taskId) : undefined,
      ),
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(limit);
  return rows.map((row) => withElapsed(row));
}

/*
 * The continuity cue for starting work on a task: where the task's latest
 * closed session said to pick it up. "Latest" is completion chronology
 * (endedAt), not when the session started - a long session that began
 * first but ended last is the most recent thing the owner did. The
 * handoff comes from that session only: if it left no next step the
 * answer is null, never an older session's stale instruction dressed up
 * as "last time". Tenant and task are both filtered here, in the owning
 * data layer; null means the surface shows nothing, not a placeholder.
 */
export async function getLastTaskHandoff(
  auth: AuthContext,
  taskId: string,
): Promise<{ nextStep: string; startedAt: Date } | null> {
  const [row] = await db
    .select({ nextStep: focusSessions.nextStep, startedAt: focusSessions.startedAt })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.workspaceId, auth.workspaceId),
        eq(focusSessions.taskId, taskId),
        inArray(focusSessions.state, ["finished", "abandoned", "interrupted"]),
        isNull(focusSessions.archivedAt),
        isNotNull(focusSessions.endedAt),
        // A handoff exists only for a session that actually ran.
        isNotNull(focusSessions.startedAt),
      ),
    )
    .orderBy(desc(focusSessions.endedAt))
    .limit(1);
  return row?.nextStep && row.startedAt ? { nextStep: row.nextStep, startedAt: row.startedAt } : null;
}

/*
 * ASH-308: the theatre's day projection over focus. A session belongs to the
 * day if it is planned for a slot in it (scheduled_at, not yet started), ran
 * in it (started_at), or is live right now. Day bounds arrive pre-resolved;
 * the query stays a plain range read.
 */
export async function listDayFocusSessions(auth: AuthContext, input: { from: Date; to: Date }) {
  const rows = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.workspaceId, auth.workspaceId),
        isNull(focusSessions.archivedAt),
        or(
          and(gte(focusSessions.scheduledAt, input.from), lt(focusSessions.scheduledAt, input.to), isNull(focusSessions.startedAt)),
          and(gte(focusSessions.startedAt, input.from), lt(focusSessions.startedAt, input.to)),
          inArray(focusSessions.state, ["running", "paused"]),
        ),
      ),
    )
    .orderBy(focusSessions.scheduledAt, focusSessions.startedAt);
  return rows.map((row) => withElapsed(row));
}
