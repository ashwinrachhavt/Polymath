import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { concepts } from "@/domains/knowledge/schema";
import { missionConcepts, missions, missionMockQuestions } from "@/domains/learning/schema";
import type { ExplainEvaluation, ExplainItGenerator } from "@/integrations/learning/explain-it";
import { seedReadDocument } from "../helpers/learning-fixtures";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The unaided sitting and the report. Proves the three rules the buyer's
 * trust depends on: a wrong answer produces a failing report, an uncertain
 * verdict never renders as proven, and a sitting with nothing answered says
 * unassessed and not-ready rather than ready.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof makeTestDb>["db"] | undefined } = { db: undefined };

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

import {
  answerMockQuestion,
  getMissionReport,
  getMockSession,
  resumeOrStartMock,
  startMockSession,
} from "@/domains/learning/mission-mock";
import { startMission } from "@/domains/learning/missions";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const TEXT =
  "An idempotency key lets a server recognise a repeated request and answer it from the stored result of the first. Without a key the server cannot tell a retry from a new request.";

type Auth = ReturnType<typeof ownerAuth>;

async function signIn(label: string): Promise<Auth> {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `mck-${label}-${Date.now()}-${Math.random()}`);
  return ownerAuth(userId, workspaceId);
}

/** A started Mission with one concept, whose source is the passage above. */
async function activeMission(auth: Auth, label: string, conceptNames: string[] = ["Idempotency"]) {
  const { documentId, extractionId } = await seedReadDocument(holder.db!, auth, TEXT, `${label} source`);
  const manifest = [{ documentId, extractionId, title: `${label} source` }];
  const [mission] = await holder
    .db!.insert(missions)
    .values({
      workspaceId: auth.workspaceId,
      goal: "Explain idempotent retries unaided",
      status: "active",
      sourceManifest: manifest,
      requestKey: crypto.randomUUID(),
    })
    .returning({ id: missions.id });
  const conceptIds: string[] = [];
  for (const [index, name] of conceptNames.entries()) {
    const [concept] = await holder
      .db!.insert(concepts)
      .values({ workspaceId: auth.workspaceId, term: name, sense: "domain" })
      .returning({ id: concepts.id });
    await holder.db!.insert(missionConcepts).values({
      workspaceId: auth.workspaceId,
      missionId: mission.id,
      conceptId: concept.id,
      ordinal: index,
      reason: "It is tested.",
      sourceQuote: TEXT.slice(0, 60),
      sourceDocumentId: documentId,
    });
    conceptIds.push(concept.id);
  }
  return { missionId: mission.id, conceptIds };
}

/** A generator that asks one grounded question and grades every answer with the verdict given. */
function grader(grade: ExplainEvaluation["grade"], quote: string): ExplainItGenerator {
  return {
    name: "fake",
    start: async () => ({
      prompt: "What does an idempotency key let the server do?",
      evidence: [{ quote, sourceIndex: 0 }],
      concept: "Idempotency",
    }),
    challenge: async () => {
      throw new Error("not used");
    },
    evaluate: async () => ({
      grade,
      feedback: `Graded ${grade}.`,
      evidence: [{ quote, sourceIndex: 0 }],
      nextQuestion: null,
      nextEvidence: [],
      nextConcept: null,
    }),
  };
}

async function sitWholeMock(
  auth: Auth,
  missionId: string,
  grade: ExplainEvaluation["grade"],
  answer = "It returns the earlier result.",
) {
  const engine = grader(grade, "An idempotency key lets a server recognise a repeated request");
  const { sessionId } = await startMockSession(auth, { missionId, requestKey: crypto.randomUUID() }, engine);
  const session = await getMockSession(auth, sessionId);
  for (const question of session!.questions) {
    await answerMockQuestion(auth, { sessionId, questionId: question.id, answer }, engine);
  }
  return sessionId;
}

suite("the unaided mock and its readiness report", () => {
  it("fails the report when a wrong answer is given, and names the concept to work on", async () => {
    const auth = await signIn("wrong");
    const { missionId } = await activeMission(auth, "wrong");
    await sitWholeMock(auth, missionId, "incorrect");

    const report = await getMissionReport(auth, missionId);
    expect(report).not.toBeNull();
    expect(report!.ready).toBe(false);
    expect(report!.overall).toMatch(/not ready yet/i);
    expect(report!.gaps).toEqual(["Idempotency"]);
    expect(report!.perConcept[0]).toMatchObject({ status: "practised", grade: "incorrect", verdict: "Not right yet" });
    // The answer is quoted exactly as written.
    expect(report!.perConcept[0].answer).toBe("It returns the earlier result.");
  });

  it("never renders an uncertain verdict as proven", async () => {
    const auth = await signIn("uncertain");
    const { missionId } = await activeMission(auth, "uncertain");
    await sitWholeMock(auth, missionId, "uncertain");

    const report = await getMissionReport(auth, missionId);
    expect(report!.ready).toBe(false);
    expect(report!.proven).toEqual([]);
    expect(report!.gaps).toEqual(["Idempotency"]);
    expect(report!.perConcept[0]).toMatchObject({
      status: "practised",
      grade: "uncertain",
      verdict: "Needs your own check",
    });
  });

  it("says a report with no attempts is unassessed, not ready", async () => {
    const auth = await signIn("empty");
    const { missionId } = await activeMission(auth, "empty");
    const report = await getMissionReport(auth, missionId);
    expect(report).not.toBeNull();
    expect(report!.attempts).toEqual([]);
    expect(report!.ready).toBe(false);
    expect(report!.overall).toMatch(/not ready yet/i);
    expect(report!.perConcept.every((row) => row.status === "unassessed" && row.verdict === "Not attempted")).toBe(
      true,
    );
  });

  it("becomes ready only when every concept is proven unaided", async () => {
    const auth = await signIn("ready");
    const { missionId } = await activeMission(auth, "ready", ["Idempotency", "Write-ahead log"]);
    await sitWholeMock(auth, missionId, "correct");
    const report = await getMissionReport(auth, missionId);
    expect(report!.ready).toBe(true);
    expect(report!.gaps).toEqual([]);
    expect(report!.overall).toMatch(/^Ready\./);
  });

  it("one proven concept beside one wrong answer is still not ready", async () => {
    const auth = await signIn("mixed");
    const { missionId } = await activeMission(auth, "mixed", ["Idempotency", "Write-ahead log"]);
    const engine = grader("correct", "An idempotency key lets a server recognise a repeated request");
    const { sessionId } = await startMockSession(auth, { missionId, requestKey: crypto.randomUUID() }, engine);
    const session = await getMockSession(auth, sessionId);
    // First correct, second incorrect.
    await answerMockQuestion(auth, { sessionId, questionId: session!.questions[0].id, answer: "Right." }, engine);
    await answerMockQuestion(
      auth,
      { sessionId, questionId: session!.questions[1].id, answer: "Wrong." },
      grader("incorrect", "An idempotency key lets a server recognise a repeated request"),
    );
    const report = await getMissionReport(auth, missionId);
    expect(report!.ready).toBe(false);
    expect(report!.proven).toEqual(["Idempotency"]);
    expect(report!.gaps).toEqual(["Write-ahead log"]);
  });

  it("stores the answer verbatim, even with surrounding whitespace trimmed only at the edges", async () => {
    const auth = await signIn("verbatim");
    const { missionId } = await activeMission(auth, "verbatim");
    const engine = grader("correct", "An idempotency key lets a server recognise a repeated request");
    const { sessionId } = await startMockSession(auth, { missionId, requestKey: crypto.randomUUID() }, engine);
    const session = await getMockSession(auth, sessionId);
    const typed = "It answers\nthe repeated request from the first result.";
    await answerMockQuestion(auth, { sessionId, questionId: session!.questions[0].id, answer: `  ${typed}  ` }, engine);
    const [question] = await holder
      .db!.select({ answer: missionMockQuestions.answer })
      .from(missionMockQuestions)
      .where(eq(missionMockQuestions.sessionId, sessionId));
    expect(question.answer).toBe(typed);
  });

  it("refuses a second sitting on a Mission that has not started", async () => {
    const auth = await signIn("draft");
    const { documentId, extractionId } = await seedReadDocument(holder.db!, auth, TEXT, "draft source");
    const [mission] = await holder
      .db!.insert(missions)
      .values({
        workspaceId: auth.workspaceId,
        goal: "Not started",
        status: "draft",
        sourceManifest: [{ documentId, extractionId, title: "draft source" }],
        requestKey: crypto.randomUUID(),
      })
      .returning({ id: missions.id });
    await expect(startMockSession(auth, { missionId: mission.id, requestKey: crypto.randomUUID() })).rejects.toThrow(
      /Start the Mission/,
    );
  });

  it("resumes the open sitting instead of asking a second time", async () => {
    const auth = await signIn("resume");
    const { missionId } = await activeMission(auth, "resume");
    // The fixture generator, not the real one: this suite has no model key,
    // and a sitting must never depend on the network to exist.
    const engine = grader("correct", "An idempotency key lets a server recognise a repeated request");
    const first = await resumeOrStartMock(auth, missionId, {}, engine);
    const second = await resumeOrStartMock(auth, missionId, {}, engine);
    expect(second.sessionId).toBe(first.sessionId);
    // A retake is a new sitting.
    const retake = await resumeOrStartMock(auth, missionId, { retake: true }, engine);
    expect(retake.sessionId).not.toBe(first.sessionId);
  });

  it("isolates a Mission's sitting from another workspace", async () => {
    const mine = await signIn("iso-mine");
    const { missionId } = await activeMission(mine, "iso");
    const { sessionId } = await startMockSession(
      mine,
      { missionId, requestKey: crypto.randomUUID() },
      grader("correct", "An idempotency key lets a server recognise a repeated request"),
    );

    const theirs = await signIn("iso-theirs");
    expect(await getMockSession(theirs, sessionId)).toBeNull();
    await expect(
      answerMockQuestion(theirs, { sessionId, questionId: crypto.randomUUID(), answer: "Sneaky." }),
    ).rejects.toThrow(/not available/);
  });

  it("starts a Mission only once its plan has concepts", async () => {
    const auth = await signIn("noplan");
    const [mission] = await holder
      .db!.insert(missions)
      .values({
        workspaceId: auth.workspaceId,
        goal: "No plan yet",
        status: "draft",
        sourceManifest: [],
        requestKey: crypto.randomUUID(),
      })
      .returning({ id: missions.id });
    await expect(startMission(auth, mission.id)).rejects.toThrow(/at least one concept/);
  });
});
