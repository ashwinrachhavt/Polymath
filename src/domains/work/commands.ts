import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { linkTargetKinds } from "@/db/columns";
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

/* One page per render; Today paginates past this when the list outgrows a screen. */
const OPEN_TASK_PAGE = 100;

export type TaskLinkInput = {
  targetType: (typeof linkTargetKinds)[number];
  targetId: string;
  label?: string;
};

/**
 * The only task insert. Defaults are status "inbox", priority "none", rank "m".
 *
 * `links` lives here rather than at each caller because "a task about a
 * document / a person / an organization" is the same edge every caller wants
 * to write, and writing it twice is how the two edges drift. The caller owns
 * the audit row, because only it knows the action name that describes the
 * change (an obligation acceptance is not a bare task creation).
 */
export async function createTask(
  auth: AuthContext,
  input: {
    title: string;
    description?: string;
    dueAt?: Date;
    rank?: string;
    links?: TaskLinkInput[];
  },
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

  if (input.links?.length) {
    await tx.insert(taskLinks).values(
      input.links.map((link) => ({
        workspaceId: auth.workspaceId,
        taskId: task.id,
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label ?? null,
      })),
    );
  }
  return task;
}

/** Owner-created task: createTask in its own transaction plus the task.created audit row. */
export async function createOwnerTask(
  auth: AuthContext,
  input: { title: string; dueAt?: Date; personId?: string; organizationId?: string },
): Promise<{ id: string }> {
  const links: TaskLinkInput[] = [];
  if (input.personId) links.push({ targetType: "person", targetId: input.personId, label: "Person" });
  if (input.organizationId) {
    links.push({ targetType: "organization", targetId: input.organizationId, label: "Organization" });
  }

  return withTransaction(async (tx) => {
    const task = await createTask(auth, { title: input.title, dueAt: input.dueAt, links }, tx);

    await recordAudit(
      auth,
      {
        action: "task.created",
        subjectType: "task",
        subjectId: task.id,
        summary: `Created task "${task.title}"`,
        metadata: {
          personId: input.personId ?? null,
          organizationId: input.organizationId ?? null,
        },
      },
      tx,
    );
    return { id: task.id };
  });
}

/** Open tasks, soonest due first, nulls last. One page; paginate when the list outgrows a screen. */
export async function listOpenTasks(auth: AuthContext) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueAt: tasks.dueAt,
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
    .limit(OPEN_TASK_PAGE);
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
