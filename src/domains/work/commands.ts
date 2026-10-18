import { and, eq, isNull, sql } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { taskLinks, tasks } from "./schema";

/*
 * The work domain's mutation surface. Minimal by design: callers outside the
 * domain (e.g. knowledge accepting an obligation) go through here so task
 * invariants live in one place.
 */

type Db = typeof db | TxDrizzle;

/** Minimal insert with defaults (status "inbox", priority "none"). Returns the row. */
export async function createTask(
  auth: AuthContext,
  input: { title: string; description?: string; dueAt?: Date; rank?: string },
  tx: Db = db,
) {
  const [task] = await tx
    .insert(tasks)
    .values({
      workspaceId: auth.workspaceId,
      title: input.title,
      description: input.description ?? null,
      dueAt: input.dueAt ?? null,
      rank: input.rank ?? "m",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return task;
}

/**
 * Owner-created task. Same row as the one obligation acceptance writes —
 * there is no second task universe — so this is createTask plus the audit
 * row an owner-initiated change owes.
 */
export async function createOwnerTask(
  auth: AuthContext,
  input: { title: string; dueAt?: Date; personId?: string; organizationId?: string },
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const task = await createTask(auth, input, tx);

    // Links are what make a task "about" someone; they live on task_links so
    // a person's tasks are one query, not a column per entity that grows.
    if (input.personId) {
      await tx.insert(taskLinks).values({
        workspaceId: auth.workspaceId,
        taskId: task.id,
        targetType: "person",
        targetId: input.personId,
        label: "Person",
      });
    }
    if (input.organizationId) {
      await tx.insert(taskLinks).values({
        workspaceId: auth.workspaceId,
        taskId: task.id,
        targetType: "organization",
        targetId: input.organizationId,
        label: "Organization",
      });
    }

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "task.created",
      subjectType: "task",
      subjectId: task.id,
      summary: `Created task "${task.title}"`,
      metadata: {
        personId: input.personId ?? null,
        organizationId: input.organizationId ?? null,
      },
    });
    return { id: task.id };
  });
}

/** Open tasks, soonest due first, nulls last. One page; pagination when the list outgrows a screen. */
export async function listOpenTasks(auth: AuthContext, input?: { limit?: number }) {
  const limit = Math.min(input?.limit ?? 100, 500);
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueAt: tasks.dueAt,
      description: tasks.description,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, auth.workspaceId),
        isNull(tasks.archivedAt),
        sql`${tasks.status} not in ('done', 'cancelled')`,
      ),
    )
    .orderBy(sql`${tasks.dueAt} asc nulls last`, tasks.createdAt)
    .limit(limit);
}

/**
 * Complete a task through the row's own guard. The WHERE clause carries the
 * current status, so a double-click is a no-op and a task completed in another
 * tab is not silently re-completed; the caller gets `null` and says so.
 */
export async function completeTask(
  auth: AuthContext,
  input: { taskId: string },
): Promise<{ id: string } | null> {
  return withTransaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set({
        status: "done",
        completedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${tasks.version} + 1`,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.workspaceId, auth.workspaceId),
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      )
      .returning({ id: tasks.id, title: tasks.title });
    if (!task) return null;
    return { id: task.id };
  });
}
