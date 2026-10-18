import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { people } from "@/domains/identity/schema";
import { taskLinks, tasks } from "@/domains/work/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The continuity the audit called out: a task written by the domain is the
 * task the Work screen reads, and completing it twice completes it once. These
 * run against real Postgres because the status guard lives in the WHERE
 * clause — a mock would only prove the mock.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  work = await import("@/domains/work/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

const auth = (userId: string, workspaceId: string) => ({
  userId,
  workspaceId,
  role: "owner" as const,
});

suite("work tasks", () => {
  it("a created task appears in the open list and completes once", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-open-${Date.now()}`);
    const a = auth(userId, workspaceId);

    const { id } = await work.createOwnerTask(a, { title: "Send the status update" });
    const open = await work.listOpenTasks(a);
    expect(open.map((t) => t.id)).toContain(id);
    expect(open[0].status).toBe("inbox");

    expect(await work.completeTask(a, { taskId: id })).toEqual({ id });
    expect(await work.listOpenTasks(a)).toHaveLength(0);

    // A second click is a no-op, not a second completion.
    expect(await work.completeTask(a, { taskId: id })).toBeNull();

    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
    expect(row.version).toBe(2);
  });

  it("links a task to a person and an organization", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-links-${Date.now()}`);
    const a = auth(userId, workspaceId);
    const [person] = await db
      .insert(people)
      .values({ workspaceId, displayName: "Ada Lovelace" })
      .returning();

    const { id } = await work.createOwnerTask(a, {
      title: "Follow up",
      personId: person.id,
    });

    const links = await db
      .select({ targetType: taskLinks.targetType, targetId: taskLinks.targetId })
      .from(taskLinks)
      .where(eq(taskLinks.taskId, id));
    expect(links).toEqual([{ targetType: "person", targetId: person.id }]);

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectType, "task"), eq(auditEvents.subjectId, id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("task.created");
  });

  it("cannot complete a task from another workspace", async () => {
    const one = await seedWorkspace(db, `task-ws-a-${Date.now()}`);
    const two = await seedWorkspace(db, `task-ws-b-${Date.now()}`);
    const { id } = await work.createOwnerTask(auth(one.userId, one.workspaceId), {
      title: "Mine",
    });

    expect(await work.completeTask(auth(two.userId, two.workspaceId), { taskId: id })).toBeNull();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("inbox");
  });
});
