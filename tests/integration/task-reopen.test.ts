import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { taskDependencies, tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Undo for terminal transitions (Product Spec): reopenTask lands a done or
 * cancelled task back in `ready`, un-settles the blocker edges its
 * completion resolved, and writes its own audit row that carries the status
 * it came from. The row's own status guard is the concurrency primitive:
 * the loser of a race sees no rows and gets `null`.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");
let cmd: typeof import("@/domains/work/task-commands");
let queries: typeof import("@/domains/work/queries");

beforeAll(async () => {
  if (!handle) return;
  db = handle.db;
  work = await import("@/domains/work/commands");
  cmd = await import("@/domains/work/task-commands");
  queries = await import("@/domains/work/queries");
});
afterAll(async () => {
  await handle?.client.end();
});

async function setup(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `reopen-${label}-${Date.now()}`);
  return { a: ownerAuth(userId, workspaceId), workspaceId };
}
const key = () => crypto.randomUUID();

suite("reopenTask - undo for terminal transitions", () => {
  it("reopens a completed task and records the previous status", async () => {
    const { a } = await setup("done");
    const { id } = await work.createOwnerTask(a, { title: "Ship the draft" });
    await work.completeTask(a, { taskId: id });
    const result = await work.reopenTask(a, { taskId: id });
    expect(result).toEqual({ id, from: "done" });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("ready");
    expect(row.completedAt).toBeNull();
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));
    expect(audit.metadata).toEqual({ from: "done" });
  });

  it("reopens a cancelled task", async () => {
    const { a } = await setup("cancelled");
    const { id } = await work.createOwnerTask(a, { title: "Obsolete" });
    await cmd.updateTask(a, { taskId: id, expectedVersion: 1, idempotencyKey: key(), patch: { status: "cancelled" } });
    const result = await work.reopenTask(a, { taskId: id });
    expect(result).toEqual({ id, from: "cancelled" });
  });

  it("un-settles the blockers its completion resolved", async () => {
    const { a, workspaceId } = await setup("blockers");
    const { id: blocker } = await work.createOwnerTask(a, { title: "Get approval" });
    const { id: blocked } = await work.createOwnerTask(a, { title: "Send contract" });
    await cmd.addDependency(a, { taskId: blocker, otherTaskId: blocked, kind: "blocks", idempotencyKey: key() });
    await work.completeTask(a, { taskId: blocker });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(0);
    await work.reopenTask(a, { taskId: blocker });
    expect((await queries.getTaskDetail(a, blocked))?.blockedBy).toHaveLength(1);
    const [edge] = await db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, workspaceId));
    expect(edge.resolvedAt).toBeNull();
  });

  it("refuses a task that is not terminal and records nothing", async () => {
    const { a } = await setup("open");
    const { id } = await work.createOwnerTask(a, { title: "Still open" });
    expect(await work.reopenTask(a, { taskId: id })).toBeNull();
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));
    expect(audits).toHaveLength(0);
  });

  it("lets exactly one of two concurrent reopens win", async () => {
    const { a } = await setup("race");
    const { id } = await work.createOwnerTask(a, { title: "Race me" });
    await work.completeTask(a, { taskId: id });
    const [x, y] = await Promise.all([work.reopenTask(a, { taskId: id }), work.reopenTask(a, { taskId: id })]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.reopened")));
    expect(audits).toHaveLength(1);
  });

  it("cannot reopen another workspace's task", async () => {
    const one = await setup("t1");
    const two = await setup("t2");
    const { id } = await work.createOwnerTask(two.a, { title: "Theirs" });
    expect(await work.reopenTask(one.a, { taskId: id })).toBeNull();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).not.toBe("ready");
  });
});
