import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
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
  subtasks: { id: string; title: string; status: (typeof tasks.$inferSelect)["status"]; rank: string }[];
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
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, rank: tasks.rank })
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
