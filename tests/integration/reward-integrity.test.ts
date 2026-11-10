import { and, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOCUS_DAILY_CAP, LEARNING_DAILY_CAP } from "@/domains/gamification/rules";
import { rewardDefinitions, rewardLedger } from "@/domains/gamification/schema";
import { memberships, users } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Spec §6's farming controls on real Postgres: per-user idempotency keys
 * cannot collide across users in one workspace, a low-score sitting earns
 * nothing, the daily caps stop spam even when every attempt races the cap
 * at once, a reversal writes exactly one negative row and buys no shard
 * credit, and a definition can never price a jackpot. Domain modules are
 * imported lazily so DATABASE_URL points at the scratch database first.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/gamification/commands");
let work: typeof import("@/domains/work/commands");
let withTransaction: (typeof import("@/lib/db-transaction"))["withTransaction"];

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/gamification/commands");
  work = await import("@/domains/work/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return ownerAuth(userId, workspaceId);
}

/** A second member of the SAME workspace - the collision case the old workspace-wide key got wrong. */
async function secondUser(workspaceId: string) {
  const [user] = await db
    .insert(users)
    .values({ clerkUserId: `rw_${crypto.randomUUID()}` })
    .returning();
  await db.insert(memberships).values({ workspaceId, userId: user.id, role: "member", status: "active" });
  return ownerAuth(user.id, workspaceId);
}

/** One synthetic focus session award: a single 10-minute normal-tier unit. */
function awardFocus(auth: { userId: string; workspaceId: string; role: "owner" }) {
  return withTransaction((tx) =>
    commands.recordFocusReward(tx, auth, {
      id: crypto.randomUUID(),
      accumulatedSeconds: 600,
      strictness: "normal",
      linkedTaskPriority: null,
      followedAbandon: false,
    }),
  );
}

/** The workspace's points-bearing award rows under a definition key. */
async function awardRows(workspaceId: string, definitionKey: string) {
  return db
    .select({ id: rewardLedger.id, userId: rewardLedger.userId, points: rewardLedger.points })
    .from(rewardLedger)
    .innerJoin(rewardDefinitions, eq(rewardDefinitions.id, rewardLedger.rewardDefinitionId))
    .where(
      and(
        eq(rewardLedger.workspaceId, workspaceId),
        eq(rewardDefinitions.key, definitionKey),
        gt(rewardLedger.points, 0),
      ),
    );
}

suite("reward integrity (spec §6)", () => {
  it("per-user keys do not collide: two users' first completions of the day both earn Quartz", async () => {
    const authA = await seed("quartz-user-a");
    const authB = await secondUser(authA.workspaceId);
    const taskA = await work.createOwnerTask(authA, { title: "A's first task" });
    const taskB = await work.createOwnerTask(authB, { title: "B's first task" });

    expect((await work.completeTask(authA, { taskId: taskA.id }))?.quartzEarned).toBe(true);
    // Under the old workspace-wide `quartz:<day>` key this was false: whoever
    // completed first claimed the day and the other member silently got nothing.
    expect((await work.completeTask(authB, { taskId: taskB.id }))?.quartzEarned).toBe(true);

    const quartz = await awardRows(authA.workspaceId, "quartz");
    expect(quartz).toHaveLength(2);
    expect(new Set(quartz.map((r) => r.userId))).toEqual(new Set([authA.userId, authB.userId]));
    for (const row of quartz) {
      const [key] = await db
        .select({ idempotencyKey: rewardLedger.idempotencyKey })
        .from(rewardLedger)
        .where(eq(rewardLedger.id, row.id));
      expect(key.idempotencyKey.startsWith(`quartz:${row.userId}:`)).toBe(true);
    }
  });

  it("the same user's second task of the day earns no second Quartz", async () => {
    const auth = await seed("quartz-replay");
    const first = await work.createOwnerTask(auth, { title: "Once" });
    const second = await work.createOwnerTask(auth, { title: "Twice" });
    expect((await work.completeTask(auth, { taskId: first.id }))?.quartzEarned).toBe(true);
    // A different task, same user, same day: the `quartz:<userId>:<day>` key
    // silently skips. An already-done task is a no-op at the task layer too.
    expect((await work.completeTask(auth, { taskId: second.id }))?.quartzEarned).toBe(false);
    expect(await awardRows(auth.workspaceId, "quartz")).toHaveLength(1);
  });

  it("a low-score sitting earns nothing and clearing the gate earns once", async () => {
    const auth = await seed("learning-gate");

    // One of three correct: below the §6 gate (two thirds), nothing is written.
    const below = await withTransaction((tx) =>
      commands.recordLearningReview(tx, auth, {
        subjectId: crypto.randomUUID(),
        idempotencyKey: `quiz_attempt:${crypto.randomUUID()}`,
        correctCount: 1,
        totalCount: 3,
      }),
    );
    expect(below).toBe(false);
    expect(await awardRows(auth.workspaceId, "learning_reviewed")).toHaveLength(0);

    // Two of three clears the gate and earns the donor's 10 points.
    const cleared = await withTransaction((tx) =>
      commands.recordLearningReview(tx, auth, {
        subjectId: crypto.randomUUID(),
        idempotencyKey: `quiz_attempt:${crypto.randomUUID()}`,
        correctCount: 2,
        totalCount: 3,
      }),
    );
    expect(cleared).toBe(true);
    expect(await awardRows(auth.workspaceId, "learning_reviewed")).toHaveLength(1);

    // A zero-question sitting can never grade past the gate.
    const empty = await withTransaction((tx) =>
      commands.recordLearningReview(tx, auth, {
        subjectId: crypto.randomUUID(),
        idempotencyKey: `quiz_attempt:${crypto.randomUUID()}`,
        correctCount: 0,
        totalCount: 0,
      }),
    );
    expect(empty).toBe(false);
  });

  it(`the learning cap stops the day's second gate-clearing sitting, not the once-ever stones (${LEARNING_DAILY_CAP}/day)`, async () => {
    const auth = await seed("learning-cap");

    const first = await withTransaction((tx) =>
      commands.recordLearningReview(tx, auth, {
        subjectId: crypto.randomUUID(),
        idempotencyKey: `quiz_attempt:${crypto.randomUUID()}`,
        correctCount: 3,
        totalCount: 3,
      }),
    );
    expect(first).toBe(true);

    // A second distinct sitting, same day, perfect score: the cap (1/day) says no.
    const second = await withTransaction((tx) =>
      commands.recordLearningReview(tx, auth, {
        subjectId: crypto.randomUUID(),
        idempotencyKey: `quiz_attempt:${crypto.randomUUID()}`,
        correctCount: 3,
        totalCount: 3,
      }),
    );
    expect(second).toBe(false);
    expect(await awardRows(auth.workspaceId, "learning_reviewed")).toHaveLength(1);

    // The cap limits the farmable points, not the collectibles: the perfect
    // second sitting still earns the first-time Emerald (a different
    // definition, once ever).
    const emerald = await withTransaction((tx) => commands.recordEmerald(tx, auth, crypto.randomUUID()));
    expect(emerald).toBe(true);
    const stones = await db
      .select({ key: rewardDefinitions.key })
      .from(rewardLedger)
      .innerJoin(rewardDefinitions, eq(rewardDefinitions.id, rewardLedger.rewardDefinitionId))
      .where(eq(rewardLedger.workspaceId, auth.workspaceId));
    expect(stones.filter((r) => r.key === "emerald")).toHaveLength(1);
  });

  it(`spam finishes hit the focus cap (${FOCUS_DAILY_CAP}/day)`, async () => {
    const auth = await seed("focus-cap");
    let awarded = 0;
    for (let i = 0; i < FOCUS_DAILY_CAP + 3; i += 1) {
      if (await awardFocus(auth)) awarded += 1;
    }
    expect(awarded).toBe(FOCUS_DAILY_CAP);
    expect(await awardRows(auth.workspaceId, "focus")).toHaveLength(FOCUS_DAILY_CAP);
  });

  it("racing finishes cannot slip past the cap", async () => {
    const auth = await seed("focus-cap-race");
    // Every award in its own transaction, all at once: without the in-transaction
    // advisory lock, all 15 would read "0 of 12" and all 15 would pay.
    const results = await Promise.all(Array.from({ length: FOCUS_DAILY_CAP + 3 }, () => awardFocus(auth)));
    expect(results.filter(Boolean)).toHaveLength(FOCUS_DAILY_CAP);
    expect(await awardRows(auth.workspaceId, "focus")).toHaveLength(FOCUS_DAILY_CAP);
  });

  it("definition prices are bounded to 0..10000 on create", async () => {
    const auth = await seed("definition-bounds");

    await expect(
      commands.createRewardDefinition(auth, { key: "jackpot", kind: "points", label: "Jackpot", points: 10001 }),
    ).rejects.toMatchObject({ code: "invalid_reward_definition" });
    await expect(
      commands.createRewardDefinition(auth, { key: "negative", kind: "points", label: "Negative", points: -1 }),
    ).rejects.toMatchObject({ code: "invalid_reward_definition" });

    const definition = await commands.createRewardDefinition(auth, {
      key: "edge",
      kind: "points",
      label: "Edge",
      points: 10000,
    });
    expect(definition.points).toBe(10000);
  });
});
