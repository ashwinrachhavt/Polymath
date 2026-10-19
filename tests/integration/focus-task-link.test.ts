import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { focusSessions } from "@/domains/focus/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Assessment item B: focus starts from a canonical task (validated in the
 * workspace), the finish record carries what changed and where to resume,
 * and finishing a session never completes the task.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let focus: typeof import("@/domains/focus/commands");
let queries: typeof import("@/domains/focus/queries");
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  focus = await import("@/domains/focus/commands");
  queries = await import("@/domains/focus/queries");
  work = await import("@/domains/work/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

suite("focus from a task", () => {
  it("validates the task in the workspace and rejects foreign or bogus ids", async () => {
    const auth = await seed("focus-validate");
    const other = await seed("focus-other");
    const foreign = await work.createOwnerTask(other, { title: "Not yours" });

    await expect(focus.startFocusSession(auth, { taskId: crypto.randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    await expect(focus.startFocusSession(auth, { taskId: foreign.id })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a task-linked finish records what changed and the next step, and the task stays open", async () => {
    const auth = await seed("focus-link");
    const task = await work.createOwnerTask(auth, { title: "Write the migration" });

    const session = await focus.startFocusSession(auth, { taskId: task.id, plannedMinutes: 25 });
    expect(session.taskId).toBe(task.id);

    const finished = await focus.finishFocusSession(auth, {
      sessionId: session.id,
      expectedVersion: session.version,
      whatChanged: "Drafted 0033",
      nextStep: "Run it against staging",
    });
    expect(finished.state).toBe("finished");
    expect(finished.whatChanged).toBe("Drafted 0033");
    expect(finished.nextStep).toBe("Run it against staging");

    // Session finished != task completed.
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.status).not.toBe("done");
    expect(row.completedAt).toBeNull();

    // The task's focus history reads back through the task filter.
    const history = await queries.listFocusHistory(auth, 10, task.id);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(session.id);
    expect(await queries.listFocusHistory(auth, 10, crypto.randomUUID())).toHaveLength(0);
  });
});
