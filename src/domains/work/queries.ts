import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { tasks } from "./schema";

/** A bounded projection of canonical tasks, shared with the agent read tool. */
export async function listOpenTasks(auth: Pick<AuthContext, "workspaceId">, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid task limit");
  return db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    priority: tasks.priority,
    dueAt: tasks.dueAt,
  }).from(tasks)
    .where(and(
      eq(tasks.workspaceId, auth.workspaceId),
      isNull(tasks.archivedAt),
      notInArray(tasks.status, ["done", "cancelled"]),
    ))
    .orderBy(sql`${tasks.rank} collate "C"`, asc(tasks.id))
    .limit(limit);
}

export type TaskDetail = {
  task: typeof tasks.$inferSelect;
  subtasks: { id: string; title: string; status: (typeof tasks.$inferSelect)["status"]; rank: string; version: number }[];
  /** Unresolved blockers, whichever way the edge was written. */
  blockedBy: { dependencyId: string; taskId: string; title: string }[];
  blocking: { dependencyId: string; taskId: string; title: string }[];
  waitingOn: { dependencyId: string; targetType: string | null; targetId: string | null; note: string | null }[];
};

/** One task with its subtasks and dependency edges: the task card's whole read. */
export async function getTaskDetail(
  auth: Pick<AuthContext, "workspaceId">,
  taskId: string,
): Promise<TaskDetail | null> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
    .limit(1);
  if (!task) return null;

  const subtasks = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, rank: tasks.rank, version: tasks.version })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
    .orderBy(sql`${tasks.rank} collate "C"`, asc(tasks.id));

  const edges = await db.execute(sql`
    select d.id as dependency_id, d.kind, d.task_id, d.depends_on_task_id,
           d.waiting_on_type, d.waiting_on_id, d.note, d.resolved_at,
           t.title as other_title
      from task_dependencies d
      left join tasks t on t.id = case when d.task_id = ${taskId} then d.depends_on_task_id else d.task_id end
     where d.workspace_id = ${auth.workspaceId}
       and (d.task_id = ${taskId} or d.depends_on_task_id = ${taskId})
       and d.resolved_at is null`);

  const detail: TaskDetail = { task, subtasks, blockedBy: [], blocking: [], waitingOn: [] };
  for (const e of edges as unknown as Array<Record<string, string | null>>) {
    const mine = e.task_id === taskId;
    const otherId = (mine ? e.depends_on_task_id : e.task_id) as string | null;
    if (e.kind === "waiting_on") {
      detail.waitingOn.push({
        dependencyId: e.dependency_id as string,
        targetType: e.waiting_on_type,
        targetId: e.waiting_on_id,
        note: e.note,
      });
      continue;
    }
    // blocks: task_id blocks depends_on. blocked_by: task_id waits on depends_on.
    const iAmBlocker = (e.kind === "blocks") === mine;
    const entry = { dependencyId: e.dependency_id as string, taskId: otherId as string, title: (e.other_title ?? "") as string };
    (iAmBlocker ? detail.blocking : detail.blockedBy).push(entry);
  }
  return detail;
}

export type WorkRow = {
  id: string;
  title: string;
  status: (typeof tasks.$inferSelect)["status"];
  priority: (typeof tasks.$inferSelect)["priority"];
  dueAt: Date | null;
  version: number;
  rank: string;
  subtaskCount: number;
  subtasksDone: number;
  /** Unresolved blockers. */
  blockedBy: number;
};

/**
 * The Work list: top-level tasks in rank order. "today" is the owner's explicit
 * commitment (Ready or In progress); "open" is everything not finished;
 * "done" is finished and cancelled work, newest first.
 */
export async function listWorkRows(
  auth: Pick<AuthContext, "workspaceId">,
  view: "today" | "open" | "done",
  limit = 100,
): Promise<WorkRow[]> {
  return selectWorkRows(auth, view, { limit, offset: 0 });
}

export const WORK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const WORK_OPEN_STATUSES = ["inbox", "backlog", "ready", "in_progress", "waiting"] as const;

export type WorkFilter = {
  query?: string;
  priority?: (typeof WORK_PRIORITIES)[number];
  status?: (typeof WORK_OPEN_STATUSES)[number];
};

/**
 * One page of the Work list plus the rows just outside it. The list's move
 * controls need the two neighbours on each side to compute a rank between
 * them, so a page boundary must not make "move up" impossible: `window`
 * carries up to two extra rows before and after, and `lead` says how many of
 * the window's leading rows are not part of the page.
 */
export async function listWorkPage(
  auth: Pick<AuthContext, "workspaceId">,
  view: "today" | "open" | "done",
  input: { limit: number; offset: number } & WorkFilter,
): Promise<{ rows: WorkRow[]; window: WorkRow[]; lead: number; total: number }> {
  const lead = Math.min(input.offset, 2);
  const window = await selectWorkRows(auth, view, { ...input, offset: input.offset - lead, limit: input.limit + lead + 2 });
  const total = await countWorkRows(auth, view, input);
  return { rows: window.slice(lead, lead + input.limit), window, lead, total };
}

function viewWhere(auth: Pick<AuthContext, "workspaceId">, view: "today" | "open" | "done", filter: WorkFilter) {
  const statusFilter =
    view === "today"
      ? sql`t.status in ('ready', 'in_progress')`
      : view === "open"
        ? sql`t.status not in ('done', 'cancelled')`
        : sql`t.status in ('done', 'cancelled')`;
  const priority = filter.priority ? sql`and t.priority = ${filter.priority}` : sql``;
  const status = filter.status ? sql`and t.status = ${filter.status}` : sql``;
  const query = filter.query?.trim() ? sql`and t.title ilike ${`%${escapeLike(filter.query.trim())}%`}` : sql``;
  return sql`t.workspace_id = ${auth.workspaceId} and t.archived_at is null and t.parent_task_id is null and ${statusFilter} ${priority} ${status} ${query}`;
}

async function countWorkRows(
  auth: Pick<AuthContext, "workspaceId">,
  view: "today" | "open" | "done",
  filter: WorkFilter,
): Promise<number> {
  const rows = await db.execute(sql`select count(*)::int as n from tasks t where ${viewWhere(auth, view, filter)}`);
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}

async function selectWorkRows(
  auth: Pick<AuthContext, "workspaceId">,
  view: "today" | "open" | "done",
  input: { limit: number; offset: number } & WorkFilter,
): Promise<WorkRow[]> {
  const order =
    view === "done" ? sql`coalesce(t.completed_at, t.cancelled_at) desc nulls last, t.id` : sql`t.rank collate "C", t.id`;
  const rows = await db.execute(sql`
    select t.id, t.title, t.status, t.priority, t.due_at, t.version, t.rank,
      (select count(*) from tasks s where s.parent_task_id = t.id and s.archived_at is null)::int as subtask_count,
      (select count(*) from tasks s where s.parent_task_id = t.id and s.archived_at is null and s.status = 'done')::int as subtasks_done,
      (select count(*) from task_dependencies d
         where d.workspace_id = t.workspace_id and d.resolved_at is null
           and ((d.kind = 'blocked_by' and d.task_id = t.id) or (d.kind = 'blocks' and d.depends_on_task_id = t.id)))::int as blocked_by
    from tasks t
    where ${viewWhere(auth, view, input)}
    order by ${order}
    limit ${input.limit} offset ${input.offset}`);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as WorkRow["status"],
    priority: r.priority as WorkRow["priority"],
    dueAt: r.due_at ? new Date(r.due_at as string) : null,
    version: r.version as number,
    rank: r.rank as string,
    subtaskCount: r.subtask_count as number,
    subtasksDone: r.subtasks_done as number,
    blockedBy: r.blocked_by as number,
  }));
}

export type DatedTask = {
  id: string;
  title: string;
  status: (typeof tasks.$inferSelect)["status"];
  priority: (typeof tasks.$inferSelect)["priority"];
  dueAt: Date;
  version: number;
};

/**
 * Top-level tasks due between two dates, inclusive, compared by UTC calendar
 * day (the task card writes due dates as noon UTC, so the day is unambiguous).
 * The calendar's whole read.
 */
export async function listTasksDueBetween(
  auth: Pick<AuthContext, "workspaceId">,
  startDay: string,
  endDay: string,
): Promise<DatedTask[]> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, priority: tasks.priority, dueAt: tasks.dueAt, version: tasks.version })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, auth.workspaceId),
        isNull(tasks.archivedAt),
        isNull(tasks.parentTaskId),
        sql`${tasks.dueAt} is not null`,
        sql`(${tasks.dueAt} at time zone 'utc')::date >= ${startDay}::date`,
        sql`(${tasks.dueAt} at time zone 'utc')::date <= ${endDay}::date`,
      ),
    )
    .orderBy(sql`${tasks.dueAt}`, sql`${tasks.rank} collate "C"`, asc(tasks.id));
  return rows.filter((r): r is typeof r & { dueAt: Date } => r.dueAt !== null);
}
