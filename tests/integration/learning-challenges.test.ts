import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { memberships, users } from "@/domains/identity/schema";
import { documentExtractions, documents, files, notebooks } from "@/domains/knowledge/schema";
import type { ChallengeContent } from "@/domains/learning/challenge-content";
import { learningChallengeAttempts, learningChallenges } from "@/domains/learning/schema";
import type { ExplainEvaluation, ExplainItGenerator, ProposedChallenge } from "@/integrations/learning/explain-it";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Practice challenges end to end against Postgres: a challenge is written
 * once from pinned sources and replayed from what was stored; an answer is
 * committed before anything is revealed; the rules grade it and the model is
 * asked only when they cannot decide; a hint or a second try never counts as
 * done alone; a repeated submit is one attempt; and another workspace or
 * learner reads nothing.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let challenges: typeof import("@/domains/learning/challenges");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  challenges = await import("@/domains/learning/challenges");
});

afterAll(async () => {
  await handle?.client.end();
});

const RULE =
  "A request repeated with the same idempotency key is answered from the stored result of the first one and has no second effect.";
const TEXT = `Retries are normal on an unreliable network. ${RULE} Without a key the server cannot tell a retry from a new request.`;

const PREDICT: ChallengeContent = {
  format: "predict",
  objective: "Decide whether a timed-out charge is safe to send again",
  situation:
    "A client sends a charge with an idempotency key. The reply is lost to a timeout, so the client sends the same request again with the same key.",
  question: "What does the server do with the second request, and why?",
  outcome: {
    kind: "terms",
    accept: [["returns the stored result", "returns the first result", "does not charge again"]],
    reject: ["charges twice", "charges again"],
  },
  reason: { kind: "terms", accept: [["idempotency key", "same key"]], reject: [] },
  answer:
    "It returns the stored result of the first request and does not charge again, because the idempotency key shows the request was already handled.",
  rule: RULE,
  hints: ["Think about what the key is for.", "The server has seen this key before.", "It replays the first result."],
};

const RIGHT = "It returns the stored result, because it recognises the same key.";
const WRONG = "The server charges twice.";
const UNCLEAR = "Nothing new happens to the card; the earlier outcome is handed back.";
const CONFLICTED = "It returns the stored result but it also charges again, since it has the same key.";

function fakeGenerator(options: { proposal?: ProposedChallenge; evaluation?: ExplainEvaluation } = {}) {
  const calls = { challenge: 0, evaluate: 0 };
  const generator: ExplainItGenerator = {
    name: "fake",
    async start() {
      throw new Error("not used");
    },
    async challenge() {
      calls.challenge++;
      return options.proposal ?? { content: PREDICT, evidence: [{ quote: RULE, sourceIndex: 0 }] };
    },
    async evaluate() {
      calls.evaluate++;
      if (!options.evaluation) throw new Error("the model must not be asked");
      return options.evaluation;
    },
  };
  return { generator, calls };
}

const modelSays = (grade: ExplainEvaluation["grade"], quote: string): ExplainEvaluation => ({
  grade,
  feedback: "The model's view of this answer.",
  evidence: [{ quote, sourceIndex: 0 }],
  nextQuestion: null,
  nextEvidence: [],
  nextConcept: null,
});

async function seedNotebookWithSource(workspaceId: string) {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: TEXT.length,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db.insert(files).values({ workspaceId, blobId: blob.id, filename: "retries.txt" }).returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId, title: "Retries", fileId: file.id, mimeType: "text/plain" })
    .returning();
  await db
    .insert(documentExtractions)
    .values({ workspaceId, documentId: doc.id, contentHash: blob.contentHash, status: "succeeded", text: TEXT });
  const [notebook] = await db.insert(notebooks).values({ workspaceId, title: "Practice" }).returning();
  return { notebookId: notebook.id, documentId: doc.id };
}

async function readyChallenge(options: Parameters<typeof fakeGenerator>[0] = {}) {
  const { userId, workspaceId } = await seedWorkspace(db, `challenge-${crypto.randomUUID().slice(0, 8)}`);
  const auth = ownerAuth(userId, workspaceId);
  const { notebookId, documentId } = await seedNotebookWithSource(workspaceId);
  const fake = fakeGenerator(options);
  const { challengeId } = await challenges.startChallenge(auth, {
    notebookId,
    documentIds: [documentId],
    format: "predict",
    idempotencyKey: crypto.randomUUID(),
  });
  await challenges.prepareChallenge(auth, challengeId, fake.generator);
  const submit = (answer: string, submitKey: string = crypto.randomUUID(), dontKnow = false) =>
    challenges.submitChallengeAttempt(auth, { notebookId, challengeId, submitKey, answer, dontKnow }, fake.generator);
  const view = async () => (await challenges.getChallenge(auth, notebookId, challengeId))!;
  return { auth, workspaceId, notebookId, documentId, challengeId, submit, view, ...fake };
}

suite("practice challenges", () => {
  it("stores the challenge once and shows nothing of the answer before a commit", async () => {
    const ctx = await readyChallenge();
    const view = await ctx.view();
    expect(view.status).toBe("ready");
    expect(view.objective).toBe(PREDICT.objective);
    expect(view.prompt).toEqual({ situation: PREDICT.situation, artifact: null, question: PREDICT.question });
    expect(view.reveal).toBeNull();
    expect(view.hints).toEqual([]);
    expect(view.hintsLeft).toBe(3);
    expect(JSON.stringify(view)).not.toContain("stored result");

    const [row] = await db.select().from(learningChallenges).where(eq(learningChallenges.id, ctx.challengeId));
    expect(row.evidence[0]).toMatchObject({ quote: RULE, startOffset: TEXT.indexOf(RULE) });
  });

  it("replays from stored content: reading and re-preparing never calls the model again", async () => {
    const ctx = await readyChallenge();
    await challenges.prepareChallenge(ctx.auth, ctx.challengeId, ctx.generator);
    await ctx.view();
    await ctx.submit(RIGHT);
    const view = await ctx.view();
    expect(ctx.calls).toEqual({ challenge: 1, evaluate: 0 });
    expect(view.reveal).toEqual({
      answer: PREDICT.answer,
      rule: RULE,
      evidence: [expect.objectContaining({ quote: RULE })],
    });
  });

  it("grades a plainly right first try by the rules, as done alone", async () => {
    const ctx = await readyChallenge();
    await ctx.submit(RIGHT);
    const [attempt] = (await ctx.view()).attempts;
    expect(attempt).toMatchObject({ grade: "correct", failedStep: null, independent: true, hintsUsed: 0 });
    expect(attempt.evidence[0].quote).toBe(RULE);
  });

  it("names the step that failed and cites the source passage", async () => {
    const ctx = await readyChallenge();
    await ctx.submit(WRONG);
    const [attempt] = (await ctx.view()).attempts;
    expect(attempt).toMatchObject({ grade: "incorrect", failedStep: "what happens", independent: false });
    expect(attempt.feedback).toContain("What is off is what happens.");
    expect(attempt.evidence[0].quote).toBe(RULE);
  });

  it("asks the model only when the rules cannot decide, and takes its grade when it quotes the source", async () => {
    const ctx = await readyChallenge({ evaluation: modelSays("correct", RULE) });
    await ctx.submit(UNCLEAR);
    expect(ctx.calls.evaluate).toBe(1);
    const [attempt] = (await ctx.view()).attempts;
    expect(attempt).toMatchObject({ grade: "correct", feedback: "The model's view of this answer." });
  });

  it("stays uncertain when the model's quote is not in the source", async () => {
    const ctx = await readyChallenge({ evaluation: modelSays("correct", "A sentence the source never says.") });
    await ctx.submit(UNCLEAR);
    const [attempt] = (await ctx.view()).attempts;
    expect(attempt.grade).toBe("uncertain");
    expect(attempt.independent).toBe(false);
  });

  it("stays uncertain when the model call fails, and still stores the attempt", async () => {
    const ctx = await readyChallenge();
    await ctx.submit(UNCLEAR);
    expect((await ctx.view()).attempts[0].grade).toBe("uncertain");
  });

  it("keeps a self-contradicting answer uncertain even when the model calls it correct", async () => {
    const ctx = await readyChallenge({ evaluation: modelSays("correct", RULE) });
    await ctx.submit(CONFLICTED);
    expect((await ctx.view()).attempts[0].grade).toBe("uncertain");
  });

  it("shows hints one at a time and never counts a hinted try as done alone", async () => {
    const ctx = await readyChallenge();
    const input = { notebookId: ctx.notebookId, challengeId: ctx.challengeId };
    await challenges.showChallengeHint(ctx.auth, input);
    await challenges.showChallengeHint(ctx.auth, input);
    let view = await ctx.view();
    expect(view.hints).toEqual(PREDICT.hints.slice(0, 2));
    expect(view.hintsLeft).toBe(1);
    await challenges.showChallengeHint(ctx.auth, input);
    await challenges.showChallengeHint(ctx.auth, input);
    expect((await ctx.view()).hints).toHaveLength(3);

    await ctx.submit(RIGHT);
    view = await ctx.view();
    expect(view.attempts[0]).toMatchObject({ grade: "correct", hintsUsed: 3, independent: false });
    expect(view.hints).toEqual([]);
  });

  it("never counts a right answer after the reveal as done alone", async () => {
    const ctx = await readyChallenge();
    await ctx.submit(WRONG);
    await ctx.submit(RIGHT);
    const { attempts } = await ctx.view();
    expect(attempts.map((a) => [a.ordinal, a.grade, a.independent])).toEqual([
      [0, "incorrect", false],
      [1, "correct", false],
    ]);
  });

  it("records I don't know as a gap with no grade, and reveals the answer", async () => {
    const ctx = await readyChallenge();
    await ctx.submit("", crypto.randomUUID(), true);
    const view = await ctx.view();
    expect(view.attempts[0]).toMatchObject({ dontKnow: true, grade: null, independent: false, answer: "" });
    expect(view.reveal?.answer).toBe(PREDICT.answer);
  });

  it("returns the first attempt for a repeated submit key, sequential or concurrent", async () => {
    const ctx = await readyChallenge();
    const key = crypto.randomUUID();
    const first = await ctx.submit(RIGHT, key);
    const again = await ctx.submit(WRONG, key);
    expect(again).toEqual({ attemptId: first.attemptId, replayed: true });

    const raceKey = crypto.randomUUID();
    const raced = await Promise.all([ctx.submit(RIGHT, raceKey), ctx.submit(RIGHT, raceKey)]);
    expect(raced[0].attemptId).toBe(raced[1].attemptId);

    const rows = await db
      .select({ ordinal: learningChallengeAttempts.ordinal, grade: learningChallengeAttempts.grade })
      .from(learningChallengeAttempts)
      .where(eq(learningChallengeAttempts.challengeId, ctx.challengeId));
    expect(rows.sort((a, b) => a.ordinal - b.ordinal)).toEqual([
      { ordinal: 0, grade: "correct" },
      { ordinal: 1, grade: "correct" },
    ]);
  });

  it("returns the same challenge for a repeated start key", async () => {
    const ctx = await readyChallenge();
    const key = crypto.randomUUID();
    const input = { notebookId: ctx.notebookId, documentIds: [ctx.documentId], format: "predict" as const };
    const first = await challenges.startChallenge(ctx.auth, { ...input, idempotencyKey: key });
    const again = await challenges.startChallenge(ctx.auth, { ...input, idempotencyKey: key });
    expect(first.created).toBe(true);
    expect(again).toEqual({ challengeId: first.challengeId, created: false });
    expect((await challenges.getChallenge(ctx.auth, ctx.notebookId, first.challengeId))?.status).toBe("preparing");
  });

  it("refuses an empty answer and an answer to a challenge that is not ready", async () => {
    const ctx = await readyChallenge();
    await expect(ctx.submit("   ")).rejects.toMatchObject({ code: "empty_answer" });
    const pending = await challenges.startChallenge(ctx.auth, {
      notebookId: ctx.notebookId,
      documentIds: [ctx.documentId],
      format: "bug_hunt",
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      challenges.submitChallengeAttempt(ctx.auth, {
        notebookId: ctx.notebookId,
        challengeId: pending.challengeId,
        submitKey: crypto.randomUUID(),
        answer: RIGHT,
        dontKnow: false,
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
  });

  it.each([
    [
      "a quote that is not in the source",
      { content: PREDICT, evidence: [{ quote: "Not in the text.", sourceIndex: 0 }] },
    ],
    [
      "a model answer that fails its own check",
      {
        content: { ...PREDICT, answer: "The request is handled in the usual way." },
        evidence: [{ quote: RULE, sourceIndex: 0 }],
      },
    ],
    [
      "a question that already contains the answer",
      {
        content: { ...PREDICT, question: "Is it true that it returns the stored result and uses the same key?" },
        evidence: [{ quote: RULE, sourceIndex: 0 }],
      },
    ],
    [
      "content that is not a challenge",
      { content: { format: "predict" }, evidence: [{ quote: RULE, sourceIndex: 0 }] },
    ],
    [
      "the other format",
      {
        content: {
          format: "bug_hunt",
          objective: PREDICT.objective,
          question: PREDICT.question,
          answer: "Line 2 breaks the same key rule.",
          rule: RULE,
          hints: PREDICT.hints,
          artifact: { kind: "log", lines: ["a", "b", "c"] },
          fault: { kind: "lines", lines: [2] },
          invariant: PREDICT.reason,
        },
        evidence: [{ quote: RULE, sourceIndex: 0 }],
      },
    ],
  ] satisfies Array<[string, ProposedChallenge]>)("fails honestly on %s", async (_name, proposal) => {
    const ctx = await readyChallenge({ proposal });
    const view = await ctx.view();
    expect(view.status).toBe("failed");
    expect(view.error).toMatch(/did not give a clear enough rule/);
    expect(view.prompt).toBeNull();
  });

  it("hides a challenge and its attempts from another workspace and another learner", async () => {
    const ctx = await readyChallenge();
    await ctx.submit(RIGHT);
    const input = { notebookId: ctx.notebookId, challengeId: ctx.challengeId };
    const answer = { ...input, submitKey: crypto.randomUUID(), answer: RIGHT, dontKnow: false };

    const foreign = await seedWorkspace(db, `challenge-foreign-${crypto.randomUUID().slice(0, 8)}`);
    const foreignAuth = ownerAuth(foreign.userId, foreign.workspaceId);
    const [teammate] = await db
      .insert(users)
      .values({ clerkUserId: `challenge_mate_${crypto.randomUUID()}` })
      .returning();
    await db
      .insert(memberships)
      .values({ workspaceId: ctx.workspaceId, userId: teammate.id, role: "member", status: "active" });
    const teammateAuth = { userId: teammate.id, workspaceId: ctx.workspaceId, role: "member" as const };

    for (const outsider of [foreignAuth, teammateAuth]) {
      expect(await challenges.getChallenge(outsider, ctx.notebookId, ctx.challengeId)).toBeNull();
      expect(await challenges.listChallenges(outsider, ctx.notebookId)).toEqual([]);
      await expect(challenges.showChallengeHint(outsider, input)).rejects.toMatchObject({ code: "not_found" });
      await expect(challenges.submitChallengeAttempt(outsider, answer)).rejects.toMatchObject({ code: "not_found" });
      await challenges.prepareChallenge(outsider, ctx.challengeId, ctx.generator);
    }
    await expect(
      challenges.startChallenge(foreignAuth, {
        notebookId: ctx.notebookId,
        documentIds: [ctx.documentId],
        format: "predict",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "invalid_sources" });

    expect(ctx.calls.challenge).toBe(1);
    expect((await ctx.view()).attempts).toHaveLength(1);
    expect(await challenges.listChallenges(ctx.auth, ctx.notebookId)).toEqual([
      expect.objectContaining({ id: ctx.challengeId, status: "ready", attemptCount: 1 }),
    ]);
  });
});
