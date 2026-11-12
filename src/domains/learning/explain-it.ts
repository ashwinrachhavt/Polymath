import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { conceptName } from "@/domains/knowledge/concepts";
import { carryTurnConcepts, linkItemsToConcepts } from "./concept-links";
import { locateQuoteNormalized } from "./locate-quote";
import { loadCurrentQuizSources, QuizGenerationError } from "./generate-quiz";
import { explainSessions, explainTurns, type ExplainEvidence, type ExplainSourceSnapshot } from "./schema";
import {
  defaultExplainItGenerator,
  EXPLAIN_IT_PROMPT_VERSION,
  type ExplainEvaluation,
  type ExplainItGenerator,
  type ExplainQuestion,
  type ExplainSource,
  type ProposedEvidence,
} from "@/integrations/learning/explain-it";

export class ExplainItError extends Error {
  constructor(
    public readonly code:
      | "invalid_sources"
      | "source_not_ready"
      | "session_not_found"
      | "session_complete"
      | "answer_already_submitted"
      | "generation_failed"
      | "evidence_unverified",
    message: string,
  ) {
    super(message);
    this.name = "ExplainItError";
  }
}

function verifyEvidence(sources: ExplainSource[], proposed: ProposedEvidence[]): ExplainEvidence[] {
  const verified: ExplainEvidence[] = [];
  for (const item of proposed) {
    const source = sources[item.sourceIndex];
    if (!source) continue;
    const span = locateQuoteNormalized(source.text, item.quote);
    if (!span) continue;
    const snapshot = source as ExplainSource & ExplainSourceSnapshot;
    if (
      verified.some(
        (entry) =>
          entry.source.documentId === snapshot.documentId && entry.quote === source.text.slice(span.start, span.end),
      )
    )
      continue;
    verified.push({
      quote: source.text.slice(span.start, span.end),
      startOffset: span.start,
      endOffset: span.end,
      source: { documentId: snapshot.documentId, extractionId: snapshot.extractionId, title: snapshot.title },
    });
  }
  return verified;
}

export async function startExplainItSession(
  auth: AuthContext,
  input: { notebookId: string; documentIds: string[]; idempotencyKey: string },
  generator?: ExplainItGenerator,
): Promise<{ sessionId: string }> {
  if (
    input.documentIds.length < 1 ||
    input.documentIds.length > 8 ||
    new Set(input.documentIds).size !== input.documentIds.length
  ) {
    throw new ExplainItError("invalid_sources", "Choose one to eight distinct sources.");
  }
  let sources;
  try {
    sources = await loadCurrentQuizSources(auth, input.documentIds);
  } catch (cause) {
    if (cause instanceof QuizGenerationError && cause.code === "no_extraction") {
      throw new ExplainItError(
        "source_not_ready",
        "Every selected source must finish reading before Explain It can start.",
      );
    }
    throw new ExplainItError("invalid_sources", "One or more selected sources are unavailable in this workspace.");
  }
  const manifest: ExplainSourceSnapshot[] = sources.map(({ documentId, extractionId, title }) => ({
    documentId,
    extractionId,
    title,
  }));
  const [prior] = await db
    .select({
      id: explainSessions.id,
      notebookId: explainSessions.notebookId,
      sourceManifest: explainSessions.sourceManifest,
    })
    .from(explainSessions)
    .where(
      and(
        eq(explainSessions.workspaceId, auth.workspaceId),
        eq(explainSessions.userId, auth.userId),
        eq(explainSessions.generationKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (prior) {
    if (prior.notebookId !== input.notebookId || JSON.stringify(prior.sourceManifest) !== JSON.stringify(manifest)) {
      throw new ExplainItError("invalid_sources", "This request key already belongs to a different study session.");
    }
    return { sessionId: prior.id };
  }

  const engine = generator ?? defaultExplainItGenerator(auth.workspaceId);
  let question: ExplainQuestion;
  try {
    question = await engine.start(sources.map(({ title, text }) => ({ title, text })));
  } catch {
    throw new ExplainItError("generation_failed", "Explain It could not create a grounded question. Try again.");
  }
  const evidence = verifyEvidence(sources, question.evidence);
  if (evidence.length === 0)
    throw new ExplainItError(
      "evidence_unverified",
      "The question could not be verified against the selected source text.",
    );

  return withTransaction(async (tx) => {
    const [session] = await tx
      .insert(explainSessions)
      .values({
        workspaceId: auth.workspaceId,
        notebookId: input.notebookId,
        userId: auth.userId,
        sourceManifest: manifest,
        generationKey: input.idempotencyKey,
        status: "active",
        questionLimit: 5,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: explainSessions.id });
    const [turn] = await tx
      .insert(explainTurns)
      .values({
        workspaceId: auth.workspaceId,
        sessionId: session.id,
        ordinal: 0,
        prompt: question.prompt.trim(),
        evidence,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: explainTurns.id });
    await linkItemsToConcepts(auth, tx, [{ explainTurnId: turn.id, concept: question.concept }]);
    await recordAudit(
      auth,
      {
        action: "learning.explain_session_started",
        subjectType: "explain_session",
        subjectId: session.id,
        summary: "Started a source-grounded Explain It session",
        metadata: { sourceCount: manifest.length, promptVersion: EXPLAIN_IT_PROMPT_VERSION },
      },
      tx,
    );
    return { sessionId: session.id };
  });
}

async function loadPinnedExplainSources(
  auth: AuthContext,
  manifest: ExplainSourceSnapshot[],
): Promise<Array<ExplainSource & ExplainSourceSnapshot>> {
  if (manifest.length === 0 || manifest.length > 8)
    throw new ExplainItError("invalid_sources", "This session has an invalid source selection.");
  const ids = manifest.map((item) => item.extractionId);
  const rows = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      extractionId: documentExtractions.id,
      text: documentExtractions.text,
      status: documentExtractions.status,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(documents.workspaceId, auth.workspaceId),
        eq(documentExtractions.workspaceId, auth.workspaceId),
        inArray(documentExtractions.id, ids),
      ),
    );
  const byId = new Map(rows.map((row) => [row.extractionId, row]));
  return manifest.map((pin) => {
    const row = byId.get(pin.extractionId);
    if (!row || row.documentId !== pin.documentId || row.status !== "succeeded" || !row.text) {
      throw new ExplainItError("source_not_ready", "A pinned source version is no longer available.");
    }
    return { documentId: row.documentId, extractionId: row.extractionId, title: pin.title, text: row.text };
  });
}

export async function getExplainItSession(
  auth: AuthContext,
  notebookId: string,
  sessionId: string,
): Promise<{
  id: string;
  status: "active" | "completed";
  title: string;
  turns: Array<{
    id: string;
    ordinal: number;
    prompt: string;
    answer: string | null;
    grade: string | null;
    feedback: string | null;
    evidence: ExplainEvidence[];
  }>;
} | null> {
  const [session] = await db
    .select({ id: explainSessions.id, status: explainSessions.status, sourceManifest: explainSessions.sourceManifest })
    .from(explainSessions)
    .where(
      and(
        eq(explainSessions.id, sessionId),
        eq(explainSessions.workspaceId, auth.workspaceId),
        eq(explainSessions.notebookId, notebookId),
        eq(explainSessions.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!session) return null;
  const turns = await db
    .select({
      id: explainTurns.id,
      ordinal: explainTurns.ordinal,
      prompt: explainTurns.prompt,
      answer: explainTurns.answer,
      grade: explainTurns.grade,
      feedback: explainTurns.feedback,
      evidence: explainTurns.evidence,
    })
    .from(explainTurns)
    .where(and(eq(explainTurns.workspaceId, auth.workspaceId), eq(explainTurns.sessionId, session.id)))
    .orderBy(asc(explainTurns.ordinal));
  return {
    id: session.id,
    status: session.status,
    title: session.sourceManifest.map((source) => source.title).join(" + "),
    turns,
  };
}

export async function answerExplainItTurn(
  auth: AuthContext,
  input: { notebookId: string; sessionId: string; turnId: string; answer: string },
  generator?: ExplainItGenerator,
): Promise<{ status: "active" | "completed" }> {
  const answer = input.answer.trim().slice(0, 5000);
  if (!answer) throw new ExplainItError("generation_failed", "Write an answer before continuing.");
  const [session] = await db
    .select({
      id: explainSessions.id,
      status: explainSessions.status,
      sourceManifest: explainSessions.sourceManifest,
      questionLimit: explainSessions.questionLimit,
    })
    .from(explainSessions)
    .where(
      and(
        eq(explainSessions.id, input.sessionId),
        eq(explainSessions.workspaceId, auth.workspaceId),
        eq(explainSessions.notebookId, input.notebookId),
        eq(explainSessions.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!session) throw new ExplainItError("session_not_found", "That Explain It session is not available.");
  if (session.status !== "active")
    throw new ExplainItError("session_complete", "This Explain It session is already complete.");

  const turns = await db
    .select({
      id: explainTurns.id,
      ordinal: explainTurns.ordinal,
      prompt: explainTurns.prompt,
      answer: explainTurns.answer,
      grade: explainTurns.grade,
    })
    .from(explainTurns)
    .where(and(eq(explainTurns.workspaceId, auth.workspaceId), eq(explainTurns.sessionId, session.id)))
    .orderBy(asc(explainTurns.ordinal));
  const current = turns.at(-1);
  if (!current || current.id !== input.turnId)
    throw new ExplainItError("session_complete", "This question is no longer current.");
  if (current.answer !== null)
    throw new ExplainItError("answer_already_submitted", "This answer has already been submitted.");

  const sources = await loadPinnedExplainSources(auth, session.sourceManifest);
  const engine = generator ?? defaultExplainItGenerator(auth.workspaceId);
  let evaluation: ExplainEvaluation;
  try {
    evaluation = await engine.evaluate({
      sources: sources.map(({ title, text }) => ({ title, text })),
      question: current.prompt,
      answer,
      history: turns.slice(0, -1).map((turn) => ({
        question: turn.prompt,
        answer: turn.answer ?? "",
        grade: turn.grade as ExplainEvaluation["grade"] | null,
      })),
    });
  } catch {
    throw new ExplainItError(
      "generation_failed",
      "The answer could not be evaluated. Your response has not been saved; try again.",
    );
  }
  const evidence = verifyEvidence(sources, evaluation.evidence);
  const nextEvidence = verifyEvidence(sources, evaluation.nextEvidence);
  const grounded = evidence.length > 0;
  const grade = grounded ? evaluation.grade : "uncertain";
  const feedback = grounded
    ? evaluation.feedback.trim().slice(0, 1200)
    : "The selected source did not provide enough evidence to assess this answer confidently.";

  const mayContinue =
    current.ordinal + 1 < session.questionLimit && Boolean(evaluation.nextQuestion?.trim()) && nextEvidence.length > 0;
  const status = mayContinue ? "active" : "completed";
  await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(explainTurns)
      .set({ answer, grade, feedback, evidence, updatedBy: auth.userId, updatedAt: new Date() })
      .where(
        and(
          eq(explainTurns.id, current.id),
          eq(explainTurns.workspaceId, auth.workspaceId),
          isNull(explainTurns.answer),
        ),
      )
      .returning({ id: explainTurns.id });
    if (!updated) throw new ExplainItError("answer_already_submitted", "This answer has already been submitted.");
    if (mayContinue) {
      const [next] = await tx
        .insert(explainTurns)
        .values({
          workspaceId: auth.workspaceId,
          sessionId: session.id,
          ordinal: current.ordinal + 1,
          prompt: evaluation.nextQuestion!.trim(),
          evidence: nextEvidence,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: explainTurns.id });
      const nextConcept = conceptName(evaluation.nextConcept);
      if (nextConcept) await linkItemsToConcepts(auth, tx, [{ explainTurnId: next.id, concept: nextConcept }]);
      else await carryTurnConcepts(auth, tx, { fromTurnId: current.id, toTurnId: next.id });
    }
    await tx
      .update(explainSessions)
      .set({ status, updatedBy: auth.userId, updatedAt: new Date() })
      .where(and(eq(explainSessions.id, session.id), eq(explainSessions.workspaceId, auth.workspaceId)));
    await recordAudit(
      auth,
      {
        action: "learning.explain_answer_submitted",
        subjectType: "explain_session",
        subjectId: session.id,
        summary: "Submitted an explanation for source-grounded feedback",
        metadata: { grade, sourceCount: session.sourceManifest.length },
      },
      tx,
    );
  });
  return { status };
}
