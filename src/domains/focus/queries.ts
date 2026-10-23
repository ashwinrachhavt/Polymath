import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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
  const openStretch =
    session.state === "running"
      ? Math.max(0, Math.floor((now.getTime() - (session.lastResumedAt ?? session.startedAt).getTime()) / 1000))
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
 * The continuity cue for starting work on a task: where the last closed
 * session said to pick it up. "Latest" is the session's startedAt - the
 * same ordering listFocusHistory uses - and tenant and task are both
 * filtered here, in the owning data layer. A task with no recorded
 * handoff (no sessions, or none that left a next step) yields null and
 * the surface shows nothing rather than a placeholder.
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
        isNotNull(focusSessions.nextStep),
      ),
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(1);
  return row?.nextStep ? { nextStep: row.nextStep, startedAt: row.startedAt } : null;
}
