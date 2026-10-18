import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
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
    .orderBy(asc(tasks.rank), asc(tasks.id))
    .limit(limit);
}
