import { sql } from "drizzle-orm";
import { listEventsBetween, type WeekEvent } from "@/domains/calendar/queries";
import { listCapturesArrivedBetween } from "@/domains/capture/queries";
import { listDayFocusSessions, type FocusSessionView } from "@/domains/focus/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";

/*
 * The theatre's one day projection (ASH-308). The day is a view, not a
 * record: focus sessions, calendar events, and today's captures, all bounded
 * by the workspace-local date. Bounds resolve the way the daybook resolves
 * them - the owner's user_preferences timezone, UTC fallback, one round trip.
 *
 * Per-source degradation is the contract (ticket section 7): each region
 * reads independently, and a failed source comes back as a labelled error
 * string for its region rather than failing the theatre.
 */

export type TheatreDay = {
  /** YYYY-MM-DD in the workspace timezone. */
  localDate: string;
  timezone: string;
  dayStart: string;
  dayEnd: string;
  sessions: FocusSessionView[];
  events: WeekEvent[];
  captures: Array<{ id: string; title: string | null; text: string | null; url: string | null; processingState: string; createdAt: Date }>;
  /** Region name -> why it is unavailable; the theatre renders a status card per region. */
  errors: Partial<Record<"sessions" | "events" | "captures", string>>;
};

async function dayBounds(auth: AuthContext): Promise<{ localDate: string; timezone: string; from: Date; to: Date }> {
  const result = await db.execute(sql`
      with ws as (
        select coalesce(
          (select timezone from user_preferences
            where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}),
          'UTC'
        ) as tz
      )
      select
        to_char(now() at time zone (select tz from ws), 'YYYY-MM-DD') as local_date,
        (select tz from ws) as timezone,
        (to_char(now() at time zone (select tz from ws), 'YYYY-MM-DD')::timestamp at time zone (select tz from ws)) as day_start,
        ((to_char(now() at time zone (select tz from ws), 'YYYY-MM-DD')::timestamp + interval '1 day') at time zone (select tz from ws)) as day_end
    `);
  const row = (result as unknown as Array<{ local_date: string; timezone: string; day_start: string; day_end: string }>)[0];
  if (!row) throw new Error("The day bounds could not be resolved.");
  return { localDate: row.local_date, timezone: row.timezone, from: new Date(row.day_start), to: new Date(row.day_end) };
}

export async function getTheatreDay(auth: AuthContext): Promise<TheatreDay> {
  const { localDate, timezone, from, to } = await dayBounds(auth);
  const errors: TheatreDay["errors"] = {};

  const [sessions, events, captures] = await Promise.all([
    listDayFocusSessions(auth, { from, to }).catch((cause: unknown) => {
      errors.sessions = cause instanceof Error ? cause.message : "The focus sessions could not be read.";
      return [] as FocusSessionView[];
    }),
    listEventsBetween(auth, from, to).catch((cause: unknown) => {
      errors.events = cause instanceof Error ? cause.message : "Calendar unavailable";
      return [] as WeekEvent[];
    }),
    listCapturesArrivedBetween(auth, { from, to }).catch((cause: unknown) => {
      errors.captures = cause instanceof Error ? cause.message : "The captures could not be read.";
      return [] as Awaited<ReturnType<typeof listCapturesArrivedBetween>>;
    }),
  ]);

  return {
    localDate,
    timezone,
    dayStart: from.toISOString(),
    dayEnd: to.toISOString(),
    sessions,
    events,
    captures,
    errors,
  };
}
