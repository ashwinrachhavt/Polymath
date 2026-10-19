import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";

/*
 * The Briefing's reads (ASH-137 A01): one query, four lists, all over the
 * canonical tasks table. "Today" is the workspace's timezone day; outcome
 * tags are the `Outcome:YYYY-MM-DD` convention the preview established,
 * carried onto canonical rows so an accepted outcome is a real task tag.
 *
 * Lives in its own module rather than queries.ts to keep the merge surface
 * with the Work-wiring stream small.
 */

export type BriefingTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  tags: string[];
  version: number;
};

export type BriefingData = {
  /** Workspace-local calendar day, YYYY-MM-DD. */
  today: string;
  outcomes: BriefingTask[];
  suggested: BriefingTask[];
  dueTodayOrOverdue: BriefingTask[];
  waiting: BriefingTask[];
};

export async function getBriefing(auth: AuthContext): Promise<BriefingData> {
  const rows = await db.execute(sql`
    with ws as (
      select coalesce(
        (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}),
        'UTC'
      ) as tz
    ),
    day as (
      select (now() at time zone (select tz from ws))::date as today
    )
    select t.id, t.title, t.status, t.priority, t.due_at, t.tags, t.version,
      (select today from day)::text as today,
      (t.tags @> ${sql`jsonb_build_array('Outcome:' || (select today from day)::text)`}) as is_outcome
    from tasks t
    where t.workspace_id = ${auth.workspaceId}
      and t.archived_at is null
      and t.parent_task_id is null
      and t.status not in ('done', 'cancelled')
    order by t.due_at asc nulls last, t.priority desc, t.rank collate "C" asc
    limit 200
  `);

  const all = (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
    priority: r.priority as string,
    dueAt: r.due_at ? new Date(r.due_at as string) : null,
    tags: (r.tags as string[]) ?? [],
    version: r.version as number,
    isOutcome: r.is_outcome as boolean,
  }));

  // The workspace-local day rides along on every row: one round trip for the
  // lists and "today". With no open tasks at all there is no row to carry it,
  // so only that case pays the tiny follow-up.
  let today = (rows as unknown as Array<{ today?: string }>)[0]?.today;
  if (!today) {
    const todayRows = await db.execute(sql`
      select (now() at time zone coalesce(
        (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}), 'UTC'
      ))::date::text as today
    `);
    today = (todayRows as unknown as Array<{ today: string }>)[0].today;
  }

  const outcomes = all.filter((t) => t.isOutcome);
  const open = all.filter((t) => !t.isOutcome && t.status !== "waiting");
  const suggested = open.slice(0, Math.max(0, 3 - outcomes.length)).map(strip);
  const dueTodayOrOverdue = open
    .filter((t) => t.dueAt && t.dueAt.toISOString().slice(0, 10) <= today)
    .map(strip);
  const waiting = all.filter((t) => !t.isOutcome && t.status === "waiting").map(strip);

  return { today, outcomes: outcomes.map(strip), suggested, dueTodayOrOverdue, waiting };
}

function strip(task: BriefingTask & { isOutcome: boolean }): BriefingTask {
  return { id: task.id, title: task.title, status: task.status, priority: task.priority, dueAt: task.dueAt, tags: task.tags, version: task.version };
}
