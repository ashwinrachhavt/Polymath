import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { rewardDefinitions, rewardLedger } from "@/domains/gamification/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The owner's A10 rules: one Quartz per day on the first completed task,
 * shards claimed by hand at five stones, donor values (10 pts, 5:1).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/gamification/commands");
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/gamification/commands");
  work = await import("@/domains/work/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function ledgerFor(workspaceId: string) {
  return db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, workspaceId));
}

suite("reward rules", () => {
  it("the first completed task of the day earns exactly one Quartz", async () => {
    const auth = await seed("quartz-rule");
    const first = await work.createOwnerTask(auth, { title: "Morning task" });
    const second = await work.createOwnerTask(auth, { title: "Second task" });
    await work.completeTask(auth, { taskId: first.id });
    await work.completeTask(auth, { taskId: second.id });

    const ledger = await ledgerFor(auth.workspaceId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("task_completed");
    expect(ledger[0].subjectId).toBe(first.id);
    expect(ledger[0].points).toBe(10); // the donor's value
    expect(ledger[0].idempotencyKey).toMatch(/^quartz:\d{4}-\d{2}-\d{2}$/);

    // The lazily-created definition is the donor's Quartz.
    const [quartz] = await db
      .select()
      .from(rewardDefinitions)
      .where(eq(rewardDefinitions.workspaceId, auth.workspaceId));
    expect(quartz.key).toBe("quartz");
    expect(quartz.points).toBe(10);
  });

  it("the completion sentence rides on the stone, and stays on the audit row when no stone is earned", async () => {
    const auth = await seed("completion-sentence");
    const first = await work.createOwnerTask(auth, { title: "First" });
    const second = await work.createOwnerTask(auth, { title: "Second" });
    await work.completeTask(auth, { taskId: first.id, sentence: "  Shipped the onboarding fix.  " });
    await work.completeTask(auth, { taskId: second.id, sentence: "Wrote the retro notes." });

    const ledger = await ledgerFor(auth.workspaceId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].subjectId).toBe(first.id);
    expect(ledger[0].note).toBe("Shipped the onboarding fix.");

    // No second stone today, but the second sentence is not lost: every
    // completion's audit row carries its note whether or not a stone was.
    const audits = await db
      .select({ subjectId: auditEvents.subjectId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "task.completed")));
    const bySubject = new Map(audits.map((a) => [a.subjectId, a.metadata as { completionNote?: string } | null]));
    expect(bySubject.get(first.id)?.completionNote).toBe("Shipped the onboarding fix.");
    expect(bySubject.get(second.id)?.completionNote).toBe("Wrote the retro notes.");
  });

  it("a racing double completion writes exactly one audit row and one stone", async () => {
    const auth = await seed("double-complete");
    const task = await work.createOwnerTask(auth, { title: "Race me" });
    const [a, b] = await Promise.all([
      work.completeTask(auth, { taskId: task.id, sentence: "first click" }),
      work.completeTask(auth, { taskId: task.id, sentence: "second click" }),
    ]);
    // The guarded UPDATE lets exactly one racer through; the other gets null.
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect((await ledgerFor(auth.workspaceId))).toHaveLength(1);
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "task.completed"), eq(auditEvents.subjectId, task.id)));
    expect(audits).toHaveLength(1);
  });

  it("lost response after commit: the conflict read confirms the sentence was recorded", async () => {
    // Simulates a request that committed but whose response never arrived:
    // the completion IS on the task and its sentence IS on the audit row, so
    // the conflict state must confirm recorded - never claim it was lost.
    const auth = await seed("lost-response");
    const queries = await import("@/domains/work/queries");
    const task = await work.createOwnerTask(auth, { title: "Committed silently" });
    const first = await work.completeTask(auth, { taskId: task.id, sentence: "Finished the migration." });
    expect(first).not.toBeNull();

    const retry = await work.completeTask(auth, { taskId: task.id, sentence: "Finished the migration." });
    expect(retry).toBeNull();
    const state = await queries.getCompletionConflictState(auth, task.id);
    expect(state).toEqual({ status: "done", completionNote: "Finished the migration." });
    // The loser wrote nothing: one audit row, one stone.
    expect(await ledgerFor(auth.workspaceId)).toHaveLength(1);
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "task.completed"), eq(auditEvents.subjectId, task.id)));
    expect(audits).toHaveLength(1);
  });

  it("a completed-elsewhere task without a note reports no recorded sentence", async () => {
    const auth = await seed("conflict-nonote");
    const queries = await import("@/domains/work/queries");
    const task = await work.createOwnerTask(auth, { title: "Done quietly" });
    await work.completeTask(auth, { taskId: task.id });
    const state = await queries.getCompletionConflictState(auth, task.id);
    expect(state).toEqual({ status: "done", completionNote: null });
  });

  it("cancelled and missing tasks are not 'already completed'", async () => {
    const auth = await seed("conflict-kinds");
    const queries = await import("@/domains/work/queries");
    const taskCommands = await import("@/domains/work/task-commands");
    const cancelled = await work.createOwnerTask(auth, { title: "Cancelled" });
    await taskCommands.updateTask(auth, { taskId: cancelled.id, expectedVersion: 1, patch: { status: "cancelled" } });
    // The completion guard refuses a cancelled task, and the conflict read
    // says cancelled - never "already completed".
    expect(await work.completeTask(auth, { taskId: cancelled.id })).toBeNull();
    expect((await queries.getCompletionConflictState(auth, cancelled.id))?.status).toBe("cancelled");
    // A task the workspace cannot see reads as unavailable, not completed.
    expect(await queries.getCompletionConflictState(auth, crypto.randomUUID())).toBeNull();
  });

  it("a blank or missing answer records no sentence", async () => {
    const auth = await seed("completion-blank");
    const blank = await work.createOwnerTask(auth, { title: "Quiet" });
    await work.completeTask(auth, { taskId: blank.id, sentence: "   " });
    const ledger = await ledgerFor(auth.workspaceId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].note).toBeNull();
  });

  it("a disabled quartz definition skips the award without blocking completion", async () => {
    const auth = await seed("quartz-disabled");
    const definition = await commands.createRewardDefinition(auth, { key: "quartz", kind: "points", label: "Quartz", points: 10 });
    await commands.updateRewardDefinition(auth, { key: "quartz", kind: "points", label: "Quartz", points: 10, expectedVersion: definition.version, active: false });
    const task = await work.createOwnerTask(auth, { title: "Quiet task" });
    await work.completeTask(auth, { taskId: task.id });
    expect(await ledgerFor(auth.workspaceId)).toHaveLength(0);
  });

  it("shards are claimed by hand: guarded below five, one claim per five stones", async () => {
    const auth = await seed("shard-claim");
    await expect(commands.claimShard(auth)).rejects.toMatchObject({ code: "conflict" });

    for (let i = 0; i < 5; i += 1) {
      const task = await work.createOwnerTask(auth, { title: `Stone ${i}` });
      // Distinct subjects but the daily quartz only fires once, so award the
      // remaining stones directly through the write path's contract.
      if (i === 0) {
        await work.completeTask(auth, { taskId: task.id });
      } else {
        await commands.awardReward(auth, {
          definitionKey: "quartz",
          reason: "task_completed",
          idempotencyKey: `extra:${task.id}`,
          subjectType: "task",
          subjectId: task.id,
        });
      }
    }

    let state = await commands.shardState(auth);
    expect(state).toEqual({ stones: 5, claimed: 0, claimable: 1 });

    await commands.claimShard(auth);
    state = await commands.shardState(auth);
    expect(state).toEqual({ stones: 5, claimed: 1, claimable: 0 });
    await expect(commands.claimShard(auth)).rejects.toMatchObject({ code: "conflict" });

    // Claims never touch the stones; the claim row itself is not a stone.
    const ledger = await ledgerFor(auth.workspaceId);
    expect(ledger).toHaveLength(6);
    expect(ledger.filter((row) => row.idempotencyKey.startsWith("shard-claim:"))).toHaveLength(1);
  });
});

suite("quartz from every completion path", () => {
  it("updateTask to done earns the daily Quartz once, and reports it from completeTask", async () => {
    const auth = await seed("quartz-update");
    const tasks = await import("@/domains/work/task-commands");
    const a = await work.createOwnerTask(auth, { title: "Board card", priority: "high", estimateMinutes: 25, tags: ["ui"] });
    const done = await tasks.updateTask(auth, { taskId: a.id, expectedVersion: 1, patch: { status: "done" } });
    expect(await ledgerFor(auth.workspaceId)).toHaveLength(1);
    // Re-saving as done is not a new completion.
    await tasks.updateTask(auth, { taskId: a.id, expectedVersion: done.version, patch: { status: "done" } });
    const b = await work.createOwnerTask(auth, { title: "Later" });
    const result = await work.completeTask(auth, { taskId: b.id });
    expect(result?.quartzEarned).toBe(false);
    expect(await ledgerFor(auth.workspaceId)).toHaveLength(1);
  });
});
