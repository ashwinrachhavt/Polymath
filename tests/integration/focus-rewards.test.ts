import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { focusSessions } from "@/domains/focus/schema";
import { rewardDefinitions, rewardLedger, userProgress } from "@/domains/gamification/schema";
import { documents, documentExtractions, files } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Focus rewards end to end on real Postgres (spec §5): the finish's own
 * transaction writes one tier-multiplied ledger row per session and rebuilds
 * user_progress from the ledger in that same transaction; a replayed award,
 * an abandoned session, or a disabled rule earns nothing. Each stone's
 * trigger is proven positive AND negative - the rule fires when its premise
 * holds and stays silent when it does not. Domain modules are imported
 * lazily so DATABASE_URL points at the scratch database first.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let focusCommands: typeof import("@/domains/focus/commands");
let gamificationCommands: typeof import("@/domains/gamification/commands");
let learningCommands: typeof import("@/domains/learning/commands");
let learningGenerate: typeof import("@/domains/learning/generate-quiz");
let learningQueries: typeof import("@/domains/learning/queries");
let workCommands: typeof import("@/domains/work/commands");
let withTransaction: (typeof import("@/lib/db-transaction"))["withTransaction"];

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  focusCommands = await import("@/domains/focus/commands");
  gamificationCommands = await import("@/domains/gamification/commands");
  learningCommands = await import("@/domains/learning/commands");
  learningGenerate = await import("@/domains/learning/generate-quiz");
  learningQueries = await import("@/domains/learning/queries");
  workCommands = await import("@/domains/work/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed() {
  const { userId, workspaceId } = await seedWorkspace(
    db,
    `focus-rewards-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  return ownerAuth(userId, workspaceId);
}

/** Move the durable clock anchors into the past so a finish banks real seconds. */
async function backdate(sessionId: string, secondsAgo: number) {
  const past = new Date(Date.now() - secondsAgo * 1000);
  await db.update(focusSessions).set({ startedAt: past, lastResumedAt: past }).where(eq(focusSessions.id, sessionId));
}

/** The user's focus ledger rows (points-bearing award rows) in this workspace. */
async function focusRows(workspaceId: string, userId: string) {
  return db
    .select({ points: rewardLedger.points, idempotencyKey: rewardLedger.idempotencyKey, reason: rewardLedger.reason })
    .from(rewardLedger)
    .where(
      and(
        eq(rewardLedger.workspaceId, workspaceId),
        eq(rewardLedger.userId, userId),
        eq(rewardLedger.reason, "focus_completed"),
      ),
    );
}

/** The user's stone rows under a definition key. */
async function hasStone(workspaceId: string, userId: string, key: string) {
  return db
    .select({ id: rewardLedger.id })
    .from(rewardLedger)
    .innerJoin(rewardDefinitions, eq(rewardDefinitions.id, rewardLedger.rewardDefinitionId))
    .where(
      and(eq(rewardLedger.workspaceId, workspaceId), eq(rewardLedger.userId, userId), eq(rewardDefinitions.key, key)),
    );
}

/** Seed `count` ledger rows on the `count` distinct days before today. */
async function earnPriorDays(auth: ReturnType<typeof ownerAuth>, count: number, pointsEach = 1) {
  const [definition] = await db
    .insert(rewardDefinitions)
    .values({
      workspaceId: auth.workspaceId,
      key: "seed",
      kind: "points",
      label: "Seed",
      points: pointsEach,
      description: "Test seed",
    })
    .returning();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 1; i <= count; i++) {
    await db.insert(rewardLedger).values({
      workspaceId: auth.workspaceId,
      rewardDefinitionId: definition.id,
      userId: auth.userId,
      reason: "task_completed",
      subjectType: "task",
      subjectId: null,
      points: pointsEach,
      idempotencyKey: `seed:${auth.workspaceId}:${i}`,
      createdAt: new Date(Date.now() - i * dayMs),
    });
  }
}

const TEXT =
  "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days. The deposit is held in escrow.";

async function seedDocument(auth: ReturnType<typeof ownerAuth>) {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "fixture.txt" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: "Fixture lease", fileId: file.id, mimeType: "text/plain" })
    .returning();
  const [extraction] = await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      contentHash: blob.contentHash,
      status: "succeeded",
      text: TEXT,
    })
    .returning();
  return { doc, extraction };
}

function fixtureQuestions() {
  return [
    {
      prompt: "What happens to rent?",
      choices: [
        { value: "rises", label: "It rises by 4%." },
        { value: "falls", label: "It falls." },
      ],
      answerValue: "rises",
      concept: "Rent increase",
      explanation: "Rent rises by 4% unless notice is given.",
      quote: "Rent rises by 4% unless the tenant gives notice within 60 days.",
    },
    {
      prompt: "Where is the deposit held?",
      choices: [
        { value: "escrow", label: "In escrow." },
        { value: "landlord", label: "By the landlord directly." },
      ],
      answerValue: "escrow",
      concept: "Deposit",
      explanation: "The deposit is held in escrow.",
      quote: "The deposit is held in escrow.",
    },
    {
      prompt: "When does the lease renew?",
      choices: [
        { value: "march-1", label: "March 1." },
        { value: "april-1", label: "April 1." },
      ],
      answerValue: "march-1",
      concept: "Renewal date",
      explanation: "The lease renews on March 1.",
      quote: "The lease renews on March 1.",
    },
  ];
}

suite("focus rewards", () => {
  it("writes one tier-multiplied ledger row per finished session and rebuilds progress in the same transaction", async () => {
    const auth = await seed();
    const session = await focusCommands.startFocusSession(auth, { subject: "Deep work block" });
    await backdate(session.id, 700); // two whole 10-minute units
    const finished = await focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });

    const rows = await focusRows(auth.workspaceId, auth.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBe(2); // ceil(700/600) = 2 units × normal ×1
    expect(rows[0].idempotencyKey).toBe(`focus:${finished.id}`);

    const [progress] = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, auth.workspaceId), eq(userProgress.userId, auth.userId)));
    expect(progress.totalPoints).toBe(2);
    expect(progress.currentStreakDays).toBe(1);
    expect(progress.longestStreakDays).toBe(1);
    expect(progress.lastActiveOn).not.toBeNull();

    // A second finish is a wrong-state rejection and writes nothing more.
    await expect(
      focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: finished.version }),
    ).rejects.toThrow();
    expect(await focusRows(auth.workspaceId, auth.userId)).toHaveLength(1);
  });

  it("is replay-proof at the award seam: a second recordFocusReward for the same session writes nothing", async () => {
    const auth = await seed();
    const session = await focusCommands.startFocusSession(auth, { subject: "Replay me" });
    await backdate(session.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });

    const replayed = await withTransaction((tx) =>
      gamificationCommands.recordFocusReward(tx, auth, {
        id: session.id,
        accumulatedSeconds: 700,
        strictness: "normal",
        linkedTaskPriority: null,
        followedAbandon: false,
      }),
    );
    expect(replayed).toBe(false);
    expect(await focusRows(auth.workspaceId, auth.userId)).toHaveLength(1);
    const [progress] = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, auth.workspaceId), eq(userProgress.userId, auth.userId)));
    expect(progress.totalPoints).toBe(2);
  });

  it("an abandoned session earns nothing", async () => {
    const auth = await seed();
    const session = await focusCommands.startFocusSession(auth, { subject: "Let go" });
    await backdate(session.id, 900);
    await focusCommands.abandonFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });

    expect(await focusRows(auth.workspaceId, auth.userId)).toHaveLength(0);
    const progress = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, auth.workspaceId), eq(userProgress.userId, auth.userId)));
    expect(progress).toHaveLength(0);
  });

  it("a disabled focus rule pays nothing and writes no progress", async () => {
    const auth = await seed();
    await db
      .insert(rewardDefinitions)
      .values({
        workspaceId: auth.workspaceId,
        key: "focus",
        kind: "points",
        label: "Focus",
        points: 0,
        description: "disabled",
        active: false,
      });
    const session = await focusCommands.startFocusSession(auth, { subject: "No pay" });
    await backdate(session.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });

    expect(await focusRows(auth.workspaceId, auth.userId)).toHaveLength(0);
    const progress = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, auth.workspaceId), eq(userProgress.userId, auth.userId)));
    expect(progress).toHaveLength(0);
  });

  it("sapphire: a deep session held to 45 focused minutes earns it; a short or normal one does not", async () => {
    const auth = await seed();
    const deep = await focusCommands.startFocusSession(auth, { subject: "Long deep block", strictness: "deep" });
    await backdate(deep.id, 2760); // 46 focused minutes
    const finished = await focusCommands.finishFocusSession(auth, { sessionId: deep.id, expectedVersion: 1 });
    expect((await hasStone(auth.workspaceId, auth.userId, "sapphire")).length).toBe(1);
    const rows = await focusRows(auth.workspaceId, auth.userId);
    expect(rows[0].points).toBe(10); // ceil(2760/600) = 5 units × deep ×2
    expect(finished.accumulatedSeconds).toBeGreaterThanOrEqual(2760);

    // Negative: deep but short stays sapphire-less.
    const shortAuth = await seed();
    const short = await focusCommands.startFocusSession(shortAuth, { subject: "Too short", strictness: "deep" });
    await backdate(short.id, 2699); // 44:59
    await focusCommands.finishFocusSession(shortAuth, { sessionId: short.id, expectedVersion: 1 });
    expect(await hasStone(shortAuth.workspaceId, shortAuth.userId, "sapphire")).toHaveLength(0);

    // Negative: long but normal too.
    const normalAuth = await seed();
    const normal = await focusCommands.startFocusSession(normalAuth, { subject: "Long normal block" });
    await backdate(normal.id, 2760);
    await focusCommands.finishFocusSession(normalAuth, { sessionId: normal.id, expectedVersion: 1 });
    expect(await hasStone(normalAuth.workspaceId, normalAuth.userId, "sapphire")).toHaveLength(0);
  });

  it("ruby: a finish on a high-priority task earns it; a normal-priority one does not", async () => {
    const auth = await seed();
    const high = await workCommands.createOwnerTask(auth, { title: "Ship the fix", priority: "high" });
    const session = await focusCommands.startFocusSession(auth, { subject: "On the fix", taskId: high.id });
    await backdate(session.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    expect((await hasStone(auth.workspaceId, auth.userId, "ruby")).length).toBe(1);

    const mediumAuth = await seed();
    const medium = await workCommands.createOwnerTask(mediumAuth, { title: "Chores", priority: "medium" });
    const plain = await focusCommands.startFocusSession(mediumAuth, { subject: "On chores", taskId: medium.id });
    await backdate(plain.id, 700);
    await focusCommands.finishFocusSession(mediumAuth, { sessionId: plain.id, expectedVersion: 1 });
    expect(await hasStone(mediumAuth.workspaceId, mediumAuth.userId, "ruby")).toHaveLength(0);
  });

  it("garnet: finishing after a let-go earns it; a first-ever finish does not", async () => {
    const auth = await seed();
    const first = await focusCommands.startFocusSession(auth, { subject: "First try" });
    await backdate(first.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: first.id, expectedVersion: 1 });
    expect(await hasStone(auth.workspaceId, auth.userId, "garnet")).toHaveLength(0);

    const dropped = await focusCommands.startFocusSession(auth, { subject: "Let go" });
    await focusCommands.abandonFocusSession(auth, { sessionId: dropped.id, expectedVersion: 1 });
    const recovery = await focusCommands.startFocusSession(auth, { subject: "Back at it" });
    await backdate(recovery.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: recovery.id, expectedVersion: 1 });
    expect((await hasStone(auth.workspaceId, auth.userId, "garnet")).length).toBe(1);
  });

  it("topaz: seven consecutive earning days earn it; six do not", async () => {
    const auth = await seed();
    await earnPriorDays(auth, 6);
    const session = await focusCommands.startFocusSession(auth, { subject: "Day seven" });
    await backdate(session.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    expect((await hasStone(auth.workspaceId, auth.userId, "topaz")).length).toBe(1);
    const [progress] = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, auth.workspaceId), eq(userProgress.userId, auth.userId)));
    expect(progress.currentStreakDays).toBe(7);
    expect(progress.longestStreakDays).toBe(7);

    const shortAuth = await seed();
    await earnPriorDays(shortAuth, 5);
    const short = await focusCommands.startFocusSession(shortAuth, { subject: "Day six" });
    await backdate(short.id, 700);
    await focusCommands.finishFocusSession(shortAuth, { sessionId: short.id, expectedVersion: 1 });
    expect(await hasStone(shortAuth.workspaceId, shortAuth.userId, "topaz")).toHaveLength(0);
    const [shortProgress] = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, shortAuth.workspaceId), eq(userProgress.userId, shortAuth.userId)));
    expect(shortProgress.currentStreakDays).toBe(6);
  });

  it("diamond: reaching level 5 (1,000 points) earns it; level 4 does not", async () => {
    const auth = await seed();
    await earnPriorDays(auth, 1, 998);
    const session = await focusCommands.startFocusSession(auth, { subject: "The last two points" });
    await backdate(session.id, 700);
    await focusCommands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    expect((await hasStone(auth.workspaceId, auth.userId, "diamond")).length).toBe(1);
    const [progress] = await db
      .select()
      .from(userProgress)
      .where(and(eq(userProgress.workspaceId, auth.workspaceId), eq(userProgress.userId, auth.userId)));
    expect(progress.totalPoints).toBe(1000);

    const lowAuth = await seed();
    await earnPriorDays(lowAuth, 1, 996);
    const low = await focusCommands.startFocusSession(lowAuth, { subject: "Still level 4" });
    await backdate(low.id, 700);
    await focusCommands.finishFocusSession(lowAuth, { sessionId: low.id, expectedVersion: 1 });
    expect(await hasStone(lowAuth.workspaceId, lowAuth.userId, "diamond")).toHaveLength(0);
  });

  it("emerald: a perfect server-graded sitting earns it; an imperfect one does not", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth);
    const { quizId } = await learningGenerate.generateQuiz(
      auth,
      { documentId: doc.id },
      {
        name: "fixture:quiz",
        generate: async () => ({ questions: fixtureQuestions() }),
      },
    );
    const sitting = await learningQueries.getQuizForSitting(auth, quizId);
    expect(sitting).not.toBeNull();

    const perfect = sitting!.questions.map((q) => ({
      questionId: q.id,
      selectedValue: q.answerValue,
      dontKnow: false,
    }));
    const result = await learningCommands.completeQuizAttempt(auth, {
      quizId,
      answers: perfect,
      idempotencyKey: `perfect-${crypto.randomUUID()}`,
    });
    expect(result.correctCount).toBe(result.totalCount);
    expect((await hasStone(auth.workspaceId, auth.userId, "emerald")).length).toBe(1);

    const flawedAuth = await seed();
    const { doc: flawedDoc } = await seedDocument(flawedAuth);
    const flawedQuiz = await learningGenerate.generateQuiz(
      flawedAuth,
      { documentId: flawedDoc.id },
      {
        name: "fixture:quiz",
        generate: async () => ({ questions: fixtureQuestions() }),
      },
    );
    const flawedSitting = await learningQueries.getQuizForSitting(flawedAuth, flawedQuiz.quizId);
    const wrong = flawedSitting!.questions.map((q, i) =>
      i === 0
        ? { questionId: q.id, selectedValue: q.choices.find((c) => c.value !== q.answerValue)!.value, dontKnow: false }
        : { questionId: q.id, selectedValue: q.answerValue, dontKnow: false },
    );
    await learningCommands.completeQuizAttempt(flawedAuth, {
      quizId: flawedQuiz.quizId,
      answers: wrong,
      idempotencyKey: `flawed-${crypto.randomUUID()}`,
    });
    expect(await hasStone(flawedAuth.workspaceId, flawedAuth.userId, "emerald")).toHaveLength(0);
  });
});
