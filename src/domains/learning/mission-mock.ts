import { and, asc, eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { concepts } from "@/domains/knowledge/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  defaultExplainItGenerator,
  type ExplainEvaluation,
  type ExplainItGenerator,
  type ExplainSource,
} from "@/integrations/learning/explain-it";
import { deriveConceptStatus, type ConceptStatus } from "./concept-status";
import { loadPinnedExplainSources, verifyEvidence } from "./explain-it";
import { getMission, type MissionView } from "./missions";
import { missionConcepts, missionMockQuestions, missionMockSessions, missions, type ExplainEvidence } from "./schema";

/*
 * The unaided performance and the report that follows it. A mock is one
 * free-response question per Mission concept, written from the Mission's own
 * sources; the learner answers with nothing in front of them, one question at
 * a time, and an answer is stored verbatim before it is graded. Grading is
 * Explain It's own evaluator, so an `uncertain` verdict is shown as "needs
 * your own check" and never rounded up to proven.
 *
 * "Proven" in the report means a question on that concept was graded correct
 * with no help in this sitting. Anything else - partial, incorrect, uncertain,
 * or unanswered - is a gap, named with the answer the person actually wrote.
 */

const MAX_ANSWER_CHARS = 5000;

export class MockError extends Error {
  constructor(
    public readonly code:
      | "mission_not_found"
      | "mission_not_active"
      | "no_concepts"
      | "session_not_found"
      | "not_current_question"
      | "already_answered"
      | "generation_failed",
    message: string,
  ) {
    super(message);
    this.name = "MockError";
  }
}

/** One reported concept: what the sitting showed, and in whose words. */
type ConceptReportRow = {
  missionConceptId: string;
  conceptId: string;
  name: string;
  status: ConceptStatus;
  /** The question asked, when one was. */
  question: string | null;
  /** The answer exactly as written, or null when none was given. */
  answer: string | null;
  grade: "correct" | "partial" | "incorrect" | "uncertain" | null;
  /** The plain verdict for this answer: correct/partial/incorrect/uncertain, or "not attempted". */
  verdict: string;
  feedback: string | null;
  /** The source passages the question rests on, quoted for the person to compare. */
  evidence: ExplainEvidence[];
};

export type MissionReport = {
  missionId: string;
  /** The answers asked of the person, in the order they were asked. */
  attempts: Array<{
    questionId: string;
    ordinal: number;
    prompt: string;
    answer: string;
    grade: "correct" | "partial" | "incorrect" | "uncertain";
    feedback: string | null;
  }>;
  perConcept: ConceptReportRow[];
  /** Concepts shown unaided, and the concepts listed as gaps by name. */
  proven: string[];
  gaps: string[];
  /** Ready only when every concept is proven; never rounded up. */
  ready: boolean;
  /** The plain overall sentence: "not ready yet", and exactly what to work on. */
  overall: string;
};

function overallStatement(proven: string[], gaps: string[]): string {
  if (gaps.length === 0) {
    return `Ready. You showed every concept unaided: ${proven.join(", ")}.`;
  }
  const work = gaps.length === 1 ? gaps[0] : `${gaps.slice(0, -1).join(", ")} and ${gaps.at(-1)}`;
  return `Not ready yet. Work on ${work} before the date.`;
}

/**
 * The sitting this visit should show: an unfinished one to resume, else a new
 * one. `retake` deliberately starts a fresh sitting (with a new key derived
 * from how many the Mission already has), so the report can offer another
 * attempt without overwriting the first one's evidence.
 */
export async function resumeOrStartMock(
  auth: AuthContext,
  missionId: string,
  options: { retake?: boolean } = {},
  generator?: ExplainItGenerator,
): Promise<{ sessionId: string }> {
  const existing = await db
    .select({
      id: missionMockSessions.id,
      status: missionMockSessions.status,
      requestKey: missionMockSessions.requestKey,
    })
    .from(missionMockSessions)
    .where(
      and(
        eq(missionMockSessions.workspaceId, auth.workspaceId),
        eq(missionMockSessions.missionId, missionId),
        eq(missionMockSessions.userId, auth.userId),
      ),
    )
    .orderBy(asc(missionMockSessions.createdAt));
  if (!options.retake) {
    const open = existing.findLast((row) => row.status !== "complete");
    if (open) {
      await prepareMockSession(auth, open.id, generator);
      return { sessionId: open.id };
    }
    const latest = existing.at(-1);
    if (latest) return { sessionId: latest.id };
  }
  const { sessionId } = await startMockSession(
    auth,
    { missionId, requestKey: `mock:${missionId}:${existing.length + 1}` },
    generator,
  );
  return { sessionId };
}

/**
 * Accepts an unaided sitting and returns at once; the questions are written
 * after the response. One session per request key, so a double-click opens
 * one sitting. Only an active Mission can be performed.
 */
export async function startMockSession(
  auth: AuthContext,
  input: { missionId: string; requestKey: string },
  generator?: ExplainItGenerator,
): Promise<{ sessionId: string; created: boolean }> {
  const mission = await getMission(auth, input.missionId);
  if (!mission) throw new MockError("mission_not_found", "That Mission is not available.");
  if (mission.status !== "active")
    throw new MockError("mission_not_active", "Start the Mission before you sit a mock interview.");
  if (mission.concepts.length === 0)
    throw new MockError("no_concepts", "This Mission has no concepts to be asked about.");

  const [prior] = await db
    .select({ id: missionMockSessions.id })
    .from(missionMockSessions)
    .where(
      and(
        eq(missionMockSessions.workspaceId, auth.workspaceId),
        eq(missionMockSessions.userId, auth.userId),
        eq(missionMockSessions.requestKey, input.requestKey),
      ),
    )
    .limit(1);
  if (prior) {
    await prepareMockSession(auth, prior.id, generator);
    return { sessionId: prior.id, created: false };
  }

  const session = await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(missionMockSessions)
      .values({
        workspaceId: auth.workspaceId,
        missionId: mission.id,
        userId: auth.userId,
        requestKey: input.requestKey,
        status: "preparing",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({
        target: [missionMockSessions.workspaceId, missionMockSessions.userId, missionMockSessions.requestKey],
      })
      .returning({ id: missionMockSessions.id });
    return row;
  });
  if (!session) {
    const [existing] = await db
      .select({ id: missionMockSessions.id })
      .from(missionMockSessions)
      .where(
        and(
          eq(missionMockSessions.workspaceId, auth.workspaceId),
          eq(missionMockSessions.userId, auth.userId),
          eq(missionMockSessions.requestKey, input.requestKey),
        ),
      )
      .limit(1);
    if (!existing) throw new MockError("generation_failed", "The sitting could not be started. Try again.");
    return { sessionId: existing.id, created: false };
  }
  await prepareMockSession(auth, session.id, generator);
  return { sessionId: session.id, created: true };
}

/**
 * Writes the sitting's questions, one per concept, from the Mission's own
 * sources. Runs after the request returns or on a reload that finds a
 * preparing row. A source passage must be located for the question to be
 * kept; a concept with no groundable question is reported as a gap, never
 * asked with a fabricated one.
 */
async function prepareMockSession(auth: AuthContext, sessionId: string, generator?: ExplainItGenerator): Promise<void> {
  const [row] = await db
    .select({
      id: missionMockSessions.id,
      missionId: missionMockSessions.missionId,
      status: missionMockSessions.status,
    })
    .from(missionMockSessions)
    .where(and(eq(missionMockSessions.id, sessionId), eq(missionMockSessions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row || row.status !== "preparing") return;
  const mission = await getMission(auth, row.missionId);
  if (!mission) return;

  // The Mission's pinned sources: loaded by its manifest, so the questions and
  // the report cite the same text the plan was drawn from.
  const sources = await loadMissionSources(auth, mission.id);
  const engine = generator ?? defaultExplainItGenerator(auth.workspaceId);

  const conceptList = mission.concepts;
  const questions: Array<{
    missionConceptId: string;
    ordinal: number;
    prompt: string;
    evidence: ExplainEvidence[];
  }> = [];
  const failures: string[] = [];
  for (const [index, concept] of conceptList.entries()) {
    try {
      const started = await engine.start([
        { title: `Concept: ${concept.name}`, text: sources.map((s) => s.text).join("\n\n") },
      ]);
      const evidence = verifyEvidence(
        sources,
        started.evidence.map((item) => ({ ...item, sourceIndex: Math.min(item.sourceIndex, sources.length - 1) })),
      );
      if (evidence.length === 0) {
        failures.push(concept.name);
        continue;
      }
      questions.push({
        missionConceptId: concept.id,
        ordinal: index,
        prompt: started.prompt,
        evidence,
      });
    } catch {
      failures.push(concept.name);
    }
  }

  if (questions.length === 0) {
    await db
      .update(missionMockSessions)
      .set({
        status: "preparing",
        error: "The sources did not give a grounded question for any concept. Try a clearer source.",
        updatedBy: auth.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(missionMockSessions.id, sessionId), eq(missionMockSessions.status, "preparing")));
    return;
  }

  await withTransaction(async (tx) => {
    await tx.insert(missionMockQuestions).values(
      questions.map((question) => ({
        workspaceId: auth.workspaceId,
        sessionId,
        missionConceptId: question.missionConceptId,
        ordinal: question.ordinal,
        prompt: question.prompt,
        evidence: question.evidence,
      })),
    );
    await tx
      .update(missionMockSessions)
      .set({
        status: "asking",
        error: failures.length > 0 ? `No grounded question for: ${failures.join(", ")}.` : null,
        updatedBy: auth.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(missionMockSessions.id, sessionId), eq(missionMockSessions.status, "preparing")));
    await recordAudit(
      auth,
      {
        action: "learning.mock_started",
        subjectType: "mission",
        subjectId: mission.id,
        summary: "Started an unaided mock interview",
        metadata: { concepts: conceptList.length, asked: questions.length },
      },
      tx,
    );
  });
}

/** The Mission's pinned source texts, by its manifest; empty when it pins none. */
async function loadMissionSources(
  auth: AuthContext,
  missionId: string,
): Promise<Array<ExplainSource & { documentId: string }>> {
  const [row] = await db
    .select({ manifest: missions.sourceManifest })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row || row.manifest.length === 0) return [];
  const sources = await loadPinnedExplainSources(auth, row.manifest);
  return sources.map((source) => ({ title: source.title, text: source.text, documentId: source.documentId }));
}

/** The sitting a person is answering, with only what the unaided rule allows before an answer. */
export type MockSessionView = {
  id: string;
  status: "preparing" | "asking" | "complete";
  error: string | null;
  questions: Array<{
    id: string;
    ordinal: number;
    conceptName: string;
    prompt: string;
    answer: string | null;
    /** Shown only after the answer is stored. */
    grade: "correct" | "partial" | "incorrect" | "uncertain" | null;
    feedback: string | null;
    evidence: ExplainEvidence[];
  }>;
};

export async function getMockSession(auth: AuthContext, sessionId: string): Promise<MockSessionView | null> {
  const [session] = await db
    .select({
      id: missionMockSessions.id,
      status: missionMockSessions.status,
      error: missionMockSessions.error,
    })
    .from(missionMockSessions)
    .where(
      and(
        eq(missionMockSessions.id, sessionId),
        eq(missionMockSessions.workspaceId, auth.workspaceId),
        eq(missionMockSessions.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!session) return null;
  const rows = await db
    .select({
      id: missionMockQuestions.id,
      ordinal: missionMockQuestions.ordinal,
      prompt: missionMockQuestions.prompt,
      answer: missionMockQuestions.answer,
      grade: missionMockQuestions.grade,
      feedback: missionMockQuestions.feedback,
      evidence: missionMockQuestions.evidence,
      conceptName: concepts.term,
    })
    .from(missionMockQuestions)
    .innerJoin(missionConcepts, eq(missionConcepts.id, missionMockQuestions.missionConceptId))
    .innerJoin(concepts, eq(concepts.id, missionConcepts.conceptId))
    .where(and(eq(missionMockQuestions.workspaceId, auth.workspaceId), eq(missionMockQuestions.sessionId, session.id)))
    .orderBy(asc(missionMockQuestions.ordinal));
  return {
    id: session.id,
    status: session.status,
    error: session.error,
    questions: rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      conceptName: row.conceptName,
      prompt: row.prompt,
      answer: row.answer,
      grade: row.grade,
      feedback: row.feedback,
      evidence: row.grade === null ? [] : row.evidence,
    })),
  };
}

/**
 * Stores one answer verbatim and grades it against the sitting's sources. An
 * answer is written before grading; a failure to grade keeps the answer and
 * reports `uncertain` rather than pretending it was assessed. Only the
 * current (lowest unanswered) question can be answered, and only once.
 */
export async function answerMockQuestion(
  auth: AuthContext,
  input: { sessionId: string; questionId: string; answer: string },
  generator?: ExplainItGenerator,
): Promise<{ status: "asking" | "complete"; grade: "correct" | "partial" | "incorrect" | "uncertain" }> {
  const answer = input.answer.trim().slice(0, MAX_ANSWER_CHARS);
  if (!answer) throw new MockError("generation_failed", "Write an answer before submitting.");

  const [session] = await db
    .select({
      id: missionMockSessions.id,
      missionId: missionMockSessions.missionId,
      status: missionMockSessions.status,
    })
    .from(missionMockSessions)
    .where(
      and(
        eq(missionMockSessions.id, input.sessionId),
        eq(missionMockSessions.workspaceId, auth.workspaceId),
        eq(missionMockSessions.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!session) throw new MockError("session_not_found", "That mock interview is not available.");
  if (session.status === "complete") throw new MockError("already_answered", "This mock interview is finished.");
  if (session.status !== "asking") throw new MockError("generation_failed", "The questions are still being written.");

  const questions = await db
    .select({
      id: missionMockQuestions.id,
      ordinal: missionMockQuestions.ordinal,
      prompt: missionMockQuestions.prompt,
      answer: missionMockQuestions.answer,
      grade: missionMockQuestions.grade,
      feedback: missionMockQuestions.feedback,
    })
    .from(missionMockQuestions)
    .where(and(eq(missionMockQuestions.workspaceId, auth.workspaceId), eq(missionMockQuestions.sessionId, session.id)))
    .orderBy(asc(missionMockQuestions.ordinal));
  const current = questions.find((question) => question.answer === null);
  if (!current) throw new MockError("already_answered", "Every question has been answered.");
  if (current.id !== input.questionId)
    throw new MockError("not_current_question", "Answer the question in front of you.");

  const sources = await loadMissionSources(auth, session.missionId);
  const engine = generator ?? defaultExplainItGenerator(auth.workspaceId);
  let evaluation: ExplainEvaluation;
  try {
    evaluation = await engine.evaluate({
      sources: sources.map(({ title, text }) => ({ title, text })),
      question: current.prompt,
      answer,
      history: questions
        .filter((question) => question.answer !== null)
        .map((question) => ({ question: question.prompt, answer: question.answer ?? "", grade: question.grade })),
    });
  } catch {
    // The answer is stored and marked unassessed: an honest "needs your own
    // check" is better than a verdict the model never gave.
    await storeAnswer(
      auth,
      session.id,
      current.id,
      answer,
      "uncertain",
      "This answer could not be checked. Read it against the source yourself.",
    );
    return { status: await settleStatus(auth, session.id), grade: "uncertain" };
  }

  const evidence = verifyEvidence(sources, evaluation.evidence);
  const grounded = evidence.length > 0;
  const grade = grounded ? evaluation.grade : "uncertain";
  const feedback = grounded
    ? evaluation.feedback.trim().slice(0, 1200)
    : "The selected source did not provide enough evidence to assess this answer confidently.";
  await storeAnswer(auth, session.id, current.id, answer, grade, feedback);
  return { status: await settleStatus(auth, session.id), grade };
}

async function storeAnswer(
  auth: AuthContext,
  sessionId: string,
  questionId: string,
  answer: string,
  grade: "correct" | "partial" | "incorrect" | "uncertain",
  feedback: string,
) {
  await withTransaction(async (tx) => {
    // Written once: a replay that lost the race writes nothing.
    const [updated] = await tx
      .update(missionMockQuestions)
      .set({ answer, grade, feedback })
      .where(
        and(
          eq(missionMockQuestions.id, questionId),
          eq(missionMockQuestions.workspaceId, auth.workspaceId),
          isNull(missionMockQuestions.answer),
        ),
      )
      .returning({ id: missionMockQuestions.id });
    if (!updated) return;
    await recordAudit(
      auth,
      {
        action: "learning.mock_answered",
        subjectType: "mission_mock_question",
        subjectId: questionId,
        summary: "Answered a mock interview question",
        metadata: { grade },
      },
      tx,
    );
  });
}

async function settleStatus(auth: AuthContext, sessionId: string): Promise<"asking" | "complete"> {
  const rows = await db
    .select({ answered: missionMockQuestions.answer })
    .from(missionMockQuestions)
    .where(and(eq(missionMockQuestions.workspaceId, auth.workspaceId), eq(missionMockQuestions.sessionId, sessionId)));
  const complete = rows.every((row) => row.answered !== null);
  if (complete) {
    await db
      .update(missionMockSessions)
      .set({ status: "complete", updatedBy: auth.userId, updatedAt: new Date() })
      .where(and(eq(missionMockSessions.id, sessionId), eq(missionMockSessions.workspaceId, auth.workspaceId)));
    return "complete";
  }
  return "asking";
}

/**
 * The readiness report for a Mission, from its latest answered sitting.
 * Every concept is one of proven (correct, unaided), a named gap, or
 * unassessed when it was never asked. The overall sentence is "not ready yet"
 * unless every concept is proven.
 */
export async function getMissionReport(auth: AuthContext, missionId: string): Promise<MissionReport | null> {
  const mission = await getMission(auth, missionId);
  if (!mission) return null;

  const sessions = await db
    .select({ id: missionMockSessions.id })
    .from(missionMockSessions)
    .where(
      and(
        eq(missionMockSessions.workspaceId, auth.workspaceId),
        eq(missionMockSessions.missionId, missionId),
        eq(missionMockSessions.userId, auth.userId),
        eq(missionMockSessions.status, "complete"),
      ),
    )
    .orderBy(asc(missionMockSessions.createdAt));
  const latest = sessions.at(-1);
  if (!latest) {
    const perConcept = mission.concepts.map((concept) => unassessedRow(concept));
    return {
      missionId,
      attempts: [],
      perConcept,
      proven: [],
      gaps: perConcept.map((row) => row.name),
      ready: false,
      overall: overallStatement(
        [],
        perConcept.map((row) => row.name),
      ),
    };
  }

  const questions = await db
    .select({
      id: missionMockQuestions.id,
      ordinal: missionMockQuestions.ordinal,
      missionConceptId: missionMockQuestions.missionConceptId,
      prompt: missionMockQuestions.prompt,
      answer: missionMockQuestions.answer,
      grade: missionMockQuestions.grade,
      feedback: missionMockQuestions.feedback,
      evidence: missionMockQuestions.evidence,
    })
    .from(missionMockQuestions)
    .where(and(eq(missionMockQuestions.workspaceId, auth.workspaceId), eq(missionMockQuestions.sessionId, latest.id)))
    .orderBy(asc(missionMockQuestions.ordinal));
  const byConcept = new Map(questions.map((question) => [question.missionConceptId, question]));

  const perConcept: ConceptReportRow[] = mission.concepts.map((concept) => {
    const question = byConcept.get(concept.id);
    if (!question || question.answer === null) return unassessedRow(concept, question?.prompt ?? null);
    const grade = question.grade ?? "uncertain";
    const status: ConceptStatus = deriveConceptStatus({
      unaidedCorrect: grade === "correct" ? 1 : 0,
      attemptCount: 1,
    });
    return {
      missionConceptId: concept.id,
      conceptId: concept.conceptId,
      name: concept.name,
      status,
      question: question.prompt,
      answer: question.answer,
      grade,
      verdict: VERDICTS[grade],
      feedback: question.feedback,
      evidence: question.evidence,
    };
  });

  const attempts = questions
    .filter((question) => question.answer !== null && question.grade !== null)
    .map((question, index) => ({
      questionId: question.id,
      ordinal: index,
      prompt: question.prompt,
      answer: question.answer!,
      grade: question.grade!,
      feedback: question.feedback,
    }));

  const proven = perConcept.filter((row) => row.status === "proven").map((row) => row.name);
  const gaps = perConcept.filter((row) => row.status !== "proven").map((row) => row.name);
  return {
    missionId,
    attempts,
    perConcept,
    proven,
    gaps,
    ready: gaps.length === 0 && perConcept.length > 0,
    overall: overallStatement(proven, gaps),
  };
}

/** Plain words for a grade. "Uncertain" is never softened into a pass. */
const VERDICTS: Record<"correct" | "partial" | "incorrect" | "uncertain", string> = {
  correct: "Correct with no help",
  partial: "Partly right",
  incorrect: "Not right yet",
  uncertain: "Needs your own check",
};

function unassessedRow(concept: MissionConceptViewLike, question: string | null = null): ConceptReportRow {
  return {
    missionConceptId: concept.id,
    conceptId: concept.conceptId,
    name: concept.name,
    status: "unassessed",
    question,
    answer: null,
    grade: null,
    verdict: "Not attempted",
    feedback: null,
    evidence: [],
  };
}

type MissionConceptViewLike = MissionView["concepts"][number];
