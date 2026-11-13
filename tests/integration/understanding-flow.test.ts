import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=the plugin's promise end to end: a coding agent's change
 * becomes a note and a check, the check grades server-side, and what the
 * person missed shows up in daily practice and in what the agent is told they
 * know; fails_when=the explainer is not tagged with its repo and commit, a
 * check leaks its answers, a miss schedules no review item (or schedules it
 * twice on a replay), a key acts for no person or for another workspace, or a
 * passed sitting is not remembered; seam=the understanding domain, the jobs
 * runner, the learning grader and the flashcard queue against a real database
 * with a scripted model; no_claim=the real model's prose, the HTTP routes and
 * the plugin's MCP transport.
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

/** A quiz model that asks about sentences it can see: five questions, the right answer always "a". */
vi.mock("@/integrations/learning/quiz-generator", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/learning/quiz-generator")>();
  const concepts = ["Idempotent writes", "Optimistic locking", "Outbox pattern", "Retry budget"];
  return {
    ...original,
    defaultQuizGenerator: () => ({
      name: "scripted-quiz",
      async generate(text: string, options?: { questionCount?: number }) {
        const sentences = text
          .split("\n")
          .filter((line) => line.length > 40 && !/^[#*\-`]|^Where:/.test(line))
          .slice(0, options?.questionCount ?? 5);
        return {
          questions: sentences.map((sentence, index) => ({
            prompt: `Question ${index + 1}: which claim does the explainer make?`,
            choices: [
              { value: "a", label: `It says: ${sentence.slice(0, 60)}` },
              { value: "b", label: "It says the opposite." },
              { value: "c", label: "It does not say." },
            ],
            answerValue: "a",
            explanation: "The explainer states this directly.",
            quote: sentence,
            concept: concepts[index % concepts.length],
          })),
        };
      },
    }),
  };
});

import { artifacts } from "@/domains/knowledge/schema";
import { createApiClient } from "@/domains/identity/machine";
import { getFlashcardDueQueue } from "@/domains/learning/flashcards";
import { runGenerationJob } from "@/domains/jobs/commands";
import { actingAuth, KeyHasNoOwnerError } from "@/domains/understanding/actor";
import { ExplainerNotFoundError, ExplainerNotReadyError, getCheck, submitCheck } from "@/domains/understanding/check";
import { explainerEngine } from "@/domains/understanding/explainer-job";
import { getExplainerView, listExplainerViews, requestExplainer } from "@/domains/understanding/explainers";
import { knownConcepts } from "@/domains/understanding/known";
import { codeExplainers } from "@/domains/understanding/schema";
import { quizQuestions } from "@/domains/learning/schema";
import { mintApiClient } from "@/domains/identity/machine";

beforeAll(() => {
  holder.db = handle.db;
  explainerEngine.make = () => ({
    name: "scripted-explainer",
    async generate() {
      return {
        title: "Cap queue retries",
        background:
          "The queue replays a failed job until it succeeds, which is safe only because every handler is idempotent.\n\nA handler that writes twice would corrupt the ledger it updates.",
        intuition: "A job that always fails should stop costing money after a fixed number of tries.",
        changes: [
          {
            title: "Spend a budget per retry",
            story: "Each retry now spends one unit of a retry budget before the job runs again.",
            refs: [
              { path: "src/queue/retry.ts", line: 11 },
              { path: "src/queue/not-in-the-diff.ts", line: 2 },
            ],
          },
          {
            title: "Park the job when the budget is gone",
            story: "A job with no budget left moves to a parked state instead of being replayed forever.",
            refs: [{ path: "src/queue/park.ts" }],
          },
          {
            title: "Show the budget in the queue view",
            story: "The queue view lists how many retries each job has left so that a stuck job is visible.",
            refs: [],
          },
        ],
        risks: ["A job that fails once in a rare while now has less room to recover."],
        concepts: ["Idempotent writes", "Optimistic locking", "Outbox pattern", "Retry budget"],
      };
    },
  });
});
afterAll(async () => {
  await handle.client.end();
});

const DIFF = [
  "diff --git a/src/queue/retry.ts b/src/queue/retry.ts",
  "--- a/src/queue/retry.ts",
  "+++ b/src/queue/retry.ts",
  "@@ -10,3 +10,5 @@",
  "+  budget -= 1;",
  "diff --git a/src/queue/park.ts b/src/queue/park.ts",
  "--- a/src/queue/park.ts",
  "+++ b/src/queue/park.ts",
  "@@ -1 +1,2 @@",
  "+export const parked = true;",
].join("\n");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function signIn(label: string) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `und-${label}-${Date.now()}`);
  const owner = { userId, workspaceId, role: "owner" as const };
  const { client } = await createApiClient(owner, {
    name: "Plugin",
    kind: "machine",
    scopes: ["understanding:read", "understanding:write"],
  });
  // What getAnyAuthContext hands a route for this key: the key's id as the "user", plus its scopes.
  const key = {
    userId: client.id,
    workspaceId,
    role: "member" as const,
    scopes: ["understanding:read", "understanding:write"],
  };
  return { owner, key, person: await actingAuth(key) };
}

async function explain(person: Awaited<ReturnType<typeof signIn>>["person"], requestKey = `k-${Math.random()}`) {
  const requested = await requestExplainer(person, {
    repo: "acme/queue",
    commit: COMMIT,
    range: "main..HEAD",
    summary: "Asked the agent to cap retries; it chose a budget over a timer.",
    diff: DIFF,
    requestKey,
  });
  if (requested.start) await runGenerationJob({ jobId: requested.start.jobId, attempt: requested.start.attempt });
  return { requested, view: (await getExplainerView(person, requested.explainer.id))! };
}

async function rightAnswers(quizId: string) {
  return holder
    .db!.select({ questionId: quizQuestions.id, value: quizQuestions.answerValue })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.ordinal);
}

describe("explain -> check -> missed concept scheduled", () => {
  it("writes a tagged note, checks it, and schedules what was missed for daily practice", async () => {
    const { person } = await signIn("flow");

    const { requested, view } = await explain(person);
    expect(requested.explainer.status).toBe("pending");
    expect(view).toMatchObject({ status: "ready", repo: "acme/queue", range: "main..HEAD", passed: false });
    expect(view.notePath).toMatch(/^\/polymath\/notes\?id=/);

    const [explainer] = await holder.db!.select().from(codeExplainers).where(eq(codeExplainers.id, view.id));
    const [note] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, explainer.artifactId!));
    expect(note.tags).toEqual(["explainer", "repo:acme/queue", "commit:0123456"]);
    expect(note.kind).toBe("note");

    const check = await getCheck(person, view.id);
    expect(check.questions).toHaveLength(5);
    expect(JSON.stringify(check)).not.toContain("answerValue");

    const right = await rightAnswers(check.quizId);
    const sitting = right.map((answer, index) => ({
      questionId: answer.questionId,
      value: index < 3 ? answer.value : "b",
    }));
    const result = await submitCheck(person, view.id, sitting);
    expect(result).toMatchObject({ correct: 3, total: 5, passed: false, reviewItemsAdded: 2 });
    expect(result.missedConcepts).toHaveLength(2);
    expect(result.questions.filter((question) => !question.correct)).toHaveLength(2);

    const due = await getFlashcardDueQueue(person);
    const missedPrompts = result.questions.filter((question) => !question.correct).map((question) => question.prompt);
    expect(due.map((card) => card.prompt)).toEqual(expect.arrayContaining(missedPrompts));

    const known = new Map((await knownConcepts(person)).map((concept) => [concept.term, concept.level]));
    for (const question of result.questions) {
      expect(known.get(question.concept!)).toBe(result.missedConcepts.includes(question.concept!) ? "shaky" : "known");
    }
    expect(result.missedConcepts.every((concept) => known.get(concept) === "shaky")).toBe(true);

    const replay = await submitCheck(person, view.id, sitting);
    expect(replay.reviewItemsAdded).toBe(2);
    expect(await getFlashcardDueQueue(person)).toHaveLength(due.length);

    const passing = await submitCheck(
      person,
      view.id,
      right.map((answer) => ({ questionId: answer.questionId, value: answer.value })),
    );
    expect(passing).toMatchObject({ correct: 5, passed: true, reviewItemsAdded: 0 });
    expect((await getExplainerView(person, view.id))!.passed).toBe(true);
    expect((await listExplainerViews(person, { repo: "acme/queue", commit: COMMIT })).map((row) => row.passed)).toEqual(
      [true],
    );
  }, 30_000);

  it("answers a repeated request with the first explainer and queues nothing new", async () => {
    const { person } = await signIn("replay");
    const first = await explain(person, "same-request");
    const again = await requestExplainer(person, {
      repo: "acme/queue",
      commit: COMMIT,
      range: null,
      summary: "again",
      diff: DIFF,
      requestKey: "same-request",
    });
    expect(again.explainer.id).toBe(first.view.id);
    expect(again.start).toBeNull();
  });

  it("keeps a pending explainer's check closed until its quiz exists", async () => {
    const { person } = await signIn("pending");
    const requested = await requestExplainer(person, {
      repo: "acme/queue",
      commit: COMMIT,
      range: null,
      summary: "s",
      diff: DIFF,
      requestKey: "pending-key",
    });
    await expect(getCheck(person, requested.explainer.id)).rejects.toBeInstanceOf(ExplainerNotReadyError);
  });
});

describe("whose understanding it is", () => {
  it("does not let another workspace read or answer an explainer", async () => {
    const mine = await signIn("owner-a");
    const theirs = await signIn("owner-b");
    const { view } = await explain(mine.person);
    expect(await getExplainerView(theirs.person, view.id)).toBeNull();
    await expect(getCheck(theirs.person, view.id)).rejects.toBeInstanceOf(ExplainerNotFoundError);
    await expect(submitCheck(theirs.person, view.id, [])).rejects.toBeInstanceOf(ExplainerNotFoundError);
  });

  it("refuses a key that no person minted", async () => {
    const { owner } = await signIn("orphan");
    const orphan = await mintApiClient({
      workspaceId: owner.workspaceId,
      name: "Pairing CLI",
      kind: "machine",
      scopes: ["understanding:read"],
    });
    await expect(
      actingAuth({
        userId: orphan.clientId,
        workspaceId: owner.workspaceId,
        role: "member",
        scopes: ["understanding:read"],
      }),
    ).rejects.toBeInstanceOf(KeyHasNoOwnerError);
  });

  it("lets a signed-in person act as themselves", async () => {
    const { owner } = await signIn("session");
    expect(await actingAuth(owner)).toBe(owner);
  });
});
