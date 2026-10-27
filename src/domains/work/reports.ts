import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { focusSessions } from "@/domains/focus/schema";
import { db } from "@/lib/db";
import { tasks } from "./schema";
import type { NarrativeSession } from "./outcome-narrative";

/*
 * D15: the weekly review read from server rows. Completions come from
 * tasks.completedAt (the real timestamp, not current status), focus minutes
 * from finished focus sessions. Days are bucketed in the caller's timezone.
 */

export type WeeklyReview = {
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
  timezone: string;
  days: Array<{ date: string; completedTasks: number; focusMinutes: number }>;
  totals: { completedTasks: number; focusMinutes: number; focusSessions: number };
  /** Consecutive days ending at `end` with a completion or focus session. */
  streak: number;
};

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekStartFor(today: string, isoWeekStart: number): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7; // 1..7
  return addDays(today, -((dow - isoWeekStart + 7) % 7));
}

export function computeStreak(active: Set<string>, end: string, days: number): number {
  let n = 0;
  for (let i = 0; i < days; i++) {
    if (!active.has(addDays(end, -i))) break;
    n++;
  }
  return n;
}

export async function getWeeklyReview(
  auth: AuthContext,
  input: { start: string; timezone: string },
): Promise<WeeklyReview> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start)) throw new Error("Start must be YYYY-MM-DD.");
  const tz = input.timezone;
  const end = addDays(input.start, 6);
  const from = sql`(${input.start}::date)::timestamp at time zone ${tz}`;
  const to = sql`((${end}::date + 1)::timestamp) at time zone ${tz}`;

  const [done, focus] = await Promise.all([
    db
      .select({ day: sql<string>`to_char(${tasks.completedAt} at time zone ${tz}, 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, auth.workspaceId), isNotNull(tasks.completedAt), gte(tasks.completedAt, from), lt(tasks.completedAt, to)))
      .groupBy(sql`1`),
    db
      .select({
        day: sql<string>`to_char(${focusSessions.endedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
        seconds: sql<number>`coalesce(sum(${focusSessions.accumulatedSeconds}), 0)::int`,
        n: sql<number>`count(*)::int`,
      })
      .from(focusSessions)
      .where(and(eq(focusSessions.workspaceId, auth.workspaceId), eq(focusSessions.state, "finished"), isNotNull(focusSessions.endedAt), gte(focusSessions.endedAt, from), lt(focusSessions.endedAt, to)))
      .groupBy(sql`1`),
  ]);
  const doneBy = new Map(done.map((r) => [r.day, r.n]));
  const focusBy = new Map(focus.map((r) => [r.day, r]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(input.start, i);
    return { date, completedTasks: doneBy.get(date) ?? 0, focusMinutes: Math.round((focusBy.get(date)?.seconds ?? 0) / 60) };
  });
  const active = new Set(days.filter((d) => d.completedTasks > 0 || d.focusMinutes > 0).map((d) => d.date));
  return {
    start: input.start,
    end,
    timezone: tz,
    days,
    totals: {
      completedTasks: days.reduce((s, d) => s + d.completedTasks, 0),
      focusMinutes: days.reduce((s, d) => s + d.focusMinutes, 0),
      focusSessions: focus.reduce((s, r) => s + r.n, 0),
    },
    streak: computeStreak(active, end, 7),
  };
}

/** Finished focus sessions in the week, with the owner's own outcome sentence (ASH-280). */
export async function listFinishedSessionsInWeek(
  auth: AuthContext,
  input: { start: string; timezone: string },
): Promise<NarrativeSession[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start)) throw new Error("Start must be YYYY-MM-DD.");
  const end = addDays(input.start, 6);
  const from = sql`(${input.start}::date)::timestamp at time zone ${input.timezone}`;
  const to = sql`((${end}::date + 1)::timestamp) at time zone ${input.timezone}`;
  const rows = await db
    .select({
      endedAt: focusSessions.endedAt,
      seconds: focusSessions.accumulatedSeconds,
      subject: focusSessions.subject,
      outcome: focusSessions.outcome,
      taskTitle: tasks.title,
    })
    .from(focusSessions)
    .leftJoin(tasks, eq(tasks.id, focusSessions.taskId))
    .where(and(eq(focusSessions.workspaceId, auth.workspaceId), eq(focusSessions.state, "finished"), isNotNull(focusSessions.endedAt), gte(focusSessions.endedAt, from), lt(focusSessions.endedAt, to)))
    .orderBy(focusSessions.endedAt)
    .limit(200);
  return rows.map((r) => ({ endedAt: r.endedAt!.toISOString(), minutes: Math.round(r.seconds / 60), subject: r.subject, outcome: r.outcome, taskTitle: r.taskTitle }));
}
