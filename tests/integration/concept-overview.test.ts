import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { concepts } from "@/domains/knowledge/schema";
import {
  conceptLinks,
  explainSessions,
  explainTurns,
  missionConcepts,
  missionMockQuestions,
  missionMockSessions,
  missions,
  quizAttempts,
  quizQuestions,
  quizzes,
} from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { seedNotebook, seedReadDocument } from "../helpers/learning-fixtures";

/*
 * The concept screen reads only what is stored: coverage counts, attempts and
 * unaided-correct answers, per concept, in one pass. It proves:
 * status follows evidence (never coverage), an older item with no link is
 * counted apart rather than against a concept, and another workspace's
 * concepts and attempts are invisible.
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

import { getConceptOverview } from "@/domains/learning/concept-overview";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

async function seedWho(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `${slug}-${Date.now()}-${Math.random()}`);
  return ownerAuth(userId, workspaceId);
}
type Auth = Awaited<ReturnType<typeof seedWho>>;

async function seedConcept(auth: Auth, term: string) {
  const [row] = await holder
    .db!.insert(concepts)
    .values({ workspaceId: auth.workspaceId, term, sense: "domain", createdBy: auth.userId, updatedBy: auth.userId })
    .returning({ id: concepts.id });
  return row.id;
}

/** A ready quiz with one question, linked to a concept (or not, for the unlinked case). */
async function seedQuizQuestion(
  auth: Auth,
  input: { answerValue: string; conceptId?: string },
): Promise<{ quizId: string; questionId: string }> {
  const { documentId, extractionId } = await seedReadDocument(holder.db!, auth, "The source says so.");
  const [quiz] = await holder
    .db!.insert(quizzes)
    .values({
      workspaceId: auth.workspaceId,
      documentId,
      sourceExtractionId: extractionId,
      title: "Fixture quiz",
      status: "ready",
      questionCount: 1,
    })
    .returning({ id: quizzes.id });
  const [question] = await holder
    .db!.insert(quizQuestions)
    .values({
      workspaceId: auth.workspaceId,
      quizId: quiz.id,
      ordinal: 0,
      prompt: "What is true?",
      choices: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      answerValue: input.answerValue,
      explanation: "Because the source says so.",
      evidence: { quote: "q", startOffset: 0, endOffset: 1 },
    })
    .returning({ id: quizQuestions.id });
  if (input.conceptId) {
    await holder.db!.insert(conceptLinks).values({
      workspaceId: auth.workspaceId,
      conceptId: input.conceptId,
      quizQuestionId: question.id,
    });
  }
  return { quizId: quiz.id, questionId: question.id };
}

async function recordAttempt(
  auth: Auth,
  quizId: string,
  answers: Array<{ questionId: string; selectedValue: string | null; dontKnow?: boolean }>,
  correctCount: number,
) {
  await holder.db!.insert(quizAttempts).values({
    workspaceId: auth.workspaceId,
    quizId,
    userId: auth.userId,
    answers: answers.map((a) => ({ ...a, dontKnow: a.dontKnow ?? false })),
    correctCount,
    totalCount: answers.length,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function seedExplainTurn(auth: Auth, conceptId: string, grade: "correct" | "uncertain" | null) {
  const notebookId = await seedNotebook(holder.db!, auth);
  const [session] = await holder
    .db!.insert(explainSessions)
    .values({
      workspaceId: auth.workspaceId,
      notebookId,
      userId: auth.userId,
      sourceManifest: [],
      generationKey: crypto.randomUUID(),
    })
    .returning({ id: explainSessions.id });
  const [turn] = await holder
    .db!.insert(explainTurns)
    .values({
      workspaceId: auth.workspaceId,
      sessionId: session.id,
      ordinal: 0,
      prompt: "Explain it.",
      answer: grade === null ? null : "An answer.",
      grade,
      feedback: grade === null ? null : "Feedback.",
      evidence: [],
    })
    .returning({ id: explainTurns.id });
  await holder.db!.insert(conceptLinks).values({
    workspaceId: auth.workspaceId,
    conceptId,
    explainTurnId: turn.id,
  });
  return turn.id as string;
}

suite("getConceptOverview", () => {
  it("says a user with no concepts has nothing to show", async () => {
    const auth = await seedWho("co-empty");
    const overview = await getConceptOverview(auth);
    expect(overview.concepts).toEqual([]);
    expect(overview.unlinked).toEqual({ questions: 0, cards: 0, explanations: 0 });
  });

  it("separates proven, practised and unassessed from stored evidence", async () => {
    const auth = await seedWho("co-status");
    const provenId = await seedConcept(auth, "Proven concept");
    const practisedId = await seedConcept(auth, "Practised concept");
    const untouchedId = await seedConcept(auth, "Untouched concept");

    // Proven: a linked quiz question answered correctly.
    const proven = await seedQuizQuestion(auth, { answerValue: "a", conceptId: provenId });
    await recordAttempt(auth, proven.quizId, [{ questionId: proven.questionId, selectedValue: "a" }], 1);

    // Practised: a linked question answered wrong.
    const practised = await seedQuizQuestion(auth, { answerValue: "a", conceptId: practisedId });
    await recordAttempt(auth, practised.quizId, [{ questionId: practised.questionId, selectedValue: "b" }], 0);

    // Untouched: a linked quiz question nobody answered.
    await seedQuizQuestion(auth, { answerValue: "a", conceptId: untouchedId });

    const byTerm = new Map((await getConceptOverview(auth)).concepts.map((row) => [row.term, row]));
    expect(byTerm.get("Proven concept")).toMatchObject({ status: "proven", unaidedCorrect: 1, attemptCount: 1 });
    expect(byTerm.get("Practised concept")).toMatchObject({ status: "practised", unaidedCorrect: 0, attemptCount: 1 });
    expect(byTerm.get("Untouched concept")).toMatchObject({ status: "unassessed", attemptCount: 0 });
    // Coverage is reported, and is not evidence.
    expect(byTerm.get("Untouched concept")!.coverage.questions).toBe(1);
  });

  it("never proves a concept from an uncertain explanation", async () => {
    const auth = await seedWho("co-uncertain");
    const conceptId = await seedConcept(auth, "Uncertain concept");
    await seedExplainTurn(auth, conceptId, "uncertain");
    const [row] = (await getConceptOverview(auth)).concepts;
    expect(row).toMatchObject({ status: "practised", unaidedCorrect: 0 });
  });

  it("proves a concept from a correct explanation", async () => {
    const auth = await seedWho("co-explain");
    const conceptId = await seedConcept(auth, "Explained concept");
    await seedExplainTurn(auth, conceptId, "correct");
    const [row] = (await getConceptOverview(auth)).concepts;
    expect(row).toMatchObject({ status: "proven", unaidedCorrect: 1 });
  });

  it("counts an older, unlinked item apart and never against a concept", async () => {
    const auth = await seedWho("co-unlinked");
    const conceptId = await seedConcept(auth, "Linked concept");
    await seedQuizQuestion(auth, { answerValue: "a", conceptId });
    await seedQuizQuestion(auth, { answerValue: "a" }); // older, untagged

    const overview = await getConceptOverview(auth);
    expect(overview.unlinked.questions).toBe(1);
    expect(overview.concepts.find((row) => row.term === "Linked concept")).toMatchObject({
      status: "unassessed",
    });
  });

  it("lists a Mission's concepts at zero coverage, and shows a proven mock answer as proven", async () => {
    const auth = await seedWho("co-mission");
    const conceptId = await seedConcept(auth, "Planned concept");
    const [mission] = await holder
      .db!.insert(missions)
      .values({
        workspaceId: auth.workspaceId,
        goal: "A goal",
        status: "active",
        sourceManifest: [],
        requestKey: crypto.randomUUID(),
      })
      .returning({ id: missions.id });
    await holder.db!.insert(missionConcepts).values({
      workspaceId: auth.workspaceId,
      missionId: mission.id,
      conceptId,
      ordinal: 0,
      reason: "Why.",
      sourceQuote: null,
      sourceDocumentId: null,
    });

    // Before any answer: listed, unassessed, zero coverage.
    const before = await getConceptOverview(auth);
    expect(before.concepts.find((row) => row.term === "Planned concept")).toMatchObject({
      status: "unassessed",
      coverage: { questions: 0, cards: 0, explanations: 0 },
    });

    // A correct mock answer proves it.
    const [mc] = await holder
      .db!.select({ id: missionConcepts.id })
      .from(missionConcepts)
      .where(eq(missionConcepts.missionId, mission.id));
    const [session] = await holder
      .db!.insert(missionMockSessions)
      .values({
        workspaceId: auth.workspaceId,
        missionId: mission.id,
        userId: auth.userId,
        requestKey: crypto.randomUUID(),
        status: "complete",
      })
      .returning({ id: missionMockSessions.id });
    await holder.db!.insert(missionMockQuestions).values({
      workspaceId: auth.workspaceId,
      sessionId: session.id,
      missionConceptId: mc.id,
      ordinal: 0,
      prompt: "Explain it.",
      answer: "An answer.",
      grade: "correct",
      feedback: "Right.",
      evidence: [],
    });

    const after = await getConceptOverview(auth);
    const row = after.concepts.find((item) => item.term === "Planned concept");
    expect(row).toMatchObject({ status: "proven", unaidedCorrect: 1 });
    // lastSeenAt is a real Date even though the aggregate came from raw SQL.
    expect(row!.lastSeenAt).toBeInstanceOf(Date);
  });

  it("keeps workspaces blind to each other's concepts and attempts", async () => {
    const mine = await seedWho("co-mine");
    const theirs = await seedWho("co-theirs");

    const otherConcept = await seedConcept(theirs, "Their secret concept");
    const otherQuiz = await seedQuizQuestion(theirs, { answerValue: "a", conceptId: otherConcept });
    await recordAttempt(theirs, otherQuiz.quizId, [{ questionId: otherQuiz.questionId, selectedValue: "a" }], 1);

    expect((await getConceptOverview(mine)).concepts).toEqual([]);
    expect((await getConceptOverview(theirs)).concepts).toHaveLength(1);
  });

  it("does not count another user's attempt on a shared concept as this person's evidence", async () => {
    // Same workspace, a second member: the rows are shared, the evidence is personal.
    const owner = await seedWho("co-team");
    const conceptId = await seedConcept(owner, "Shared concept");
    const question = await seedQuizQuestion(owner, { answerValue: "a", conceptId });
    // An attempt by someone else in the same workspace.
    const otherAuth = { ...owner, userId: (await seedWho("co-team-b")).userId };
    await holder.db!.insert(quizAttempts).values({
      workspaceId: owner.workspaceId,
      quizId: question.quizId,
      userId: otherAuth.userId,
      answers: [{ questionId: question.questionId, selectedValue: "a", dontKnow: false }],
      correctCount: 1,
      totalCount: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    const [row] = (await getConceptOverview(owner)).concepts;
    expect(row).toMatchObject({ status: "unassessed", attemptCount: 0 });
  });
});
