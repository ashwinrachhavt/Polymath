import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { locateQuoteNormalized } from "@/domains/learning/locate-quote";
import { currentExtractionIdSubquery } from "@/domains/knowledge/versions";
import {
  defaultQuizGenerator,
  QUIZ_PROMPT_VERSION,
  type GeneratedQuestion,
  type QuizGenerator,
} from "@/integrations/learning/quiz-generator";
import { quizzes, quizQuestions, type QuizEvidence, type QuizSourceSnapshot } from "./schema";
import { quizGenerationContext } from "./generation-context";
import {
  defaultItemCount,
  generateInBatches,
  MAX_ITEM_COUNT,
  MAX_LEARNING_SOURCES,
  MIN_ITEM_COUNT,
  type GenerationOutcome,
} from "./item-count";

/*
 * The quiz generator's domain half (learn-harness replication). Producing a
 * quiz is the reading summary's shape with one deliberate deviation: no
 * generate-then-accept split. A summary persists as notes the owner must
 * curate; a quiz is low-stakes, regenerable, quota-gated content, so an
 * accept modal would add friction to exactly the loop we want frictionless.
 * Regenerating creates a new quiz row and the surface shows the latest
 * ready one.
 *
 * The trust boundary is the same as ASH-292's: verifyQuiz re-locates every
 * question's quote verbatim in the extraction the quiz was generated from
 * and drops whatever it cannot prove, so generation never persists
 * user-visible content that skipped verification.
 */

/** The fewest verified questions that make a quiz worth keeping. */
export const MIN_QUIZ_QUESTIONS = 3;
const MAX_PROMPT_CHARS = 300;
const MAX_CHOICE_LABEL_CHARS = 200;
const MAX_CHOICE_VALUE_CHARS = 60;
const MAX_EVIDENCE_QUOTE_CHARS = 400;
const MAX_EXPLANATION_CHARS = 800;
const MAX_QUIZ_TITLE_CHARS = 200;
const MAX_ERROR_CHARS = 500;

export class QuizGenerationError extends Error {
  constructor(
    public readonly code:
      "document_not_found" | "no_extraction" | "invalid_sources" | "insufficient_evidence" | "generation_failed",
    message: string,
  ) {
    super(message);
    this.name = "QuizGenerationError";
  }
}

/**
 * The authored sentence per failure code - the one copy both the action edge
 * (what the verb shows now) and the failed row (what the library shows after
 * a reload) speak, so verb and library never disagree. A driver's error text
 * never reaches the screen.
 */
export const GENERATION_COPY: Record<QuizGenerationError["code"], string> = {
  document_not_found: "That document is not in this workspace.",
  no_extraction: "This document is still being read. Try again once its text is ready.",
  invalid_sources: "Choose one to eight distinct sources.",
  insufficient_evidence: "Not enough of this document could be verified against its text to build an honest quiz.",
  generation_failed: "The quiz generator did not answer. Try again in a moment.",
};

export type VerifiedQuestion = {
  prompt: string;
  choices: Array<{ value: string; label: string }>;
  answerValue: string;
  explanation: string;
  evidence: QuizEvidence;
};

export type VerifiedQuiz = {
  questions: VerifiedQuestion[];
  /** Questions the model offered but could not prove against the text. */
  droppedQuestions: number;
};

export type QuizSourceText = QuizSourceSnapshot & { text: string };

/*
 * Pure trust boundary between the model's proposal and a persistable quiz.
 * A question survives only when: the prompt is non-empty, choices number
 * 2-5 with unique non-empty values, answerValue names one of those values,
 * the explanation is non-empty, and the quote re-locates in the text
 * (normalized matching - formatting-tolerant, content-strict, see
 * locate-quote.ts). Everything else is dropped and counted, never repaired.
 */
export function verifyQuiz(text: string, raw: GeneratedQuestion[], limit = MAX_ITEM_COUNT): VerifiedQuiz {
  const questions: VerifiedQuestion[] = [];
  let droppedQuestions = 0;
  for (const q of raw) {
    const prompt = q.prompt?.trim();
    const explanation = q.explanation?.trim();
    const quote = q.quote?.trim();
    const choices = Array.isArray(q.choices) ? q.choices : [];
    const values = new Set(choices.map((c) => c.value?.trim()));
    const answerValue = q.answerValue?.trim();
    if (
      !prompt ||
      !explanation ||
      !quote ||
      !answerValue ||
      choices.length < 2 ||
      choices.length > 5 ||
      values.size !== choices.length ||
      !values.has(answerValue) ||
      choices.some(
        (c) =>
          !c.label?.trim() ||
          // Truncating a label could leave two distinct choices with an
          // identical visible label - over-long labels are dropped, never
          // repaired (same rule as choice values).
          c.label.trim().length > MAX_CHOICE_LABEL_CHARS ||
          !c.value?.trim() ||
          // Truncating values could collide distinct choices into one
          // value and corrupt value-keyed grading - over-long values are
          // dropped, never repaired.
          c.value.trim().length > MAX_CHOICE_VALUE_CHARS,
      )
    ) {
      droppedQuestions++;
      continue;
    }
    const storedQuote = quote.slice(0, MAX_EVIDENCE_QUOTE_CHARS);
    const span = locateQuoteNormalized(text, storedQuote);
    if (!span) {
      droppedQuestions++;
      continue;
    }
    questions.push({
      prompt: prompt.slice(0, MAX_PROMPT_CHARS),
      choices: choices.map((c) => ({
        value: c.value.trim(),
        label: c.label.trim(),
      })),
      answerValue,
      explanation: explanation.slice(0, MAX_EXPLANATION_CHARS),
      evidence: {
        quote: storedQuote,
        startOffset: span.start,
        // The offsets describe the stored quote: normalizing the raw span
        // they cut returns the stored quote. Raw bytes can differ (markdown
        // link syntax the model quotes past); the normalized equality is
        // the guarantee.
        endOffset: span.end,
      },
    });
    if (questions.length >= limit) break;
  }
  return { questions, droppedQuestions };
}

/** Verify each question against the exact source version it names. */
export function verifyQuizAcrossSources(
  sources: QuizSourceText[],
  raw: GeneratedQuestion[],
  limit = MAX_ITEM_COUNT,
): VerifiedQuiz {
  const questions: VerifiedQuestion[] = [];
  let droppedQuestions = 0;
  for (const question of raw) {
    const sourceIndex = question.sourceIndex ?? (sources.length === 1 ? 0 : -1);
    const source = sources[sourceIndex];
    if (!source) {
      droppedQuestions += 1;
      continue;
    }
    const verified = verifyQuiz(source.text, [question], limit);
    droppedQuestions += verified.droppedQuestions;
    if (verified.questions[0]) {
      questions.push({
        ...verified.questions[0],
        evidence: {
          ...verified.questions[0].evidence,
          source: { documentId: source.documentId, extractionId: source.extractionId, title: source.title },
        },
      });
    }
    if (questions.length >= limit) break;
  }
  return { questions, droppedQuestions };
}

/**
 * Whether a stored manifest names the same document versions in the same
 * order. Compares fields, not JSON text: jsonb does not keep key order, so a
 * stored manifest never stringifies like a fresh one.
 */
export function sameSourceVersions(stored: QuizSourceSnapshot[], current: QuizSourceSnapshot[]): boolean {
  return (
    stored.length === current.length &&
    stored.every(
      (source, i) => source.documentId === current[i].documentId && source.extractionId === current[i].extractionId,
    )
  );
}

export async function loadCurrentQuizSources(auth: AuthContext, documentIds: string[]): Promise<QuizSourceText[]> {
  if (
    documentIds.length === 0 ||
    documentIds.length > MAX_LEARNING_SOURCES ||
    new Set(documentIds).size !== documentIds.length
  ) {
    throw new QuizGenerationError("invalid_sources", "Choose between one and eight distinct sources.");
  }
  const docs = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, documentIds)));
  if (docs.length !== documentIds.length) {
    throw new QuizGenerationError("document_not_found", "One or more selected sources are not in this workspace.");
  }
  const extractions = await db
    .select({
      documentId: documents.id,
      extractionId: documentExtractions.id,
      text: documentExtractions.text,
      status: documentExtractions.status,
    })
    .from(documents)
    .innerJoin(documentExtractions, eq(documentExtractions.documentId, documents.id))
    .where(
      and(
        eq(documents.workspaceId, auth.workspaceId),
        inArray(documents.id, documentIds),
        eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
      ),
    );
  const byDocument = new Map(extractions.map((row) => [row.documentId, row]));
  const byTitle = new Map(docs.map((row) => [row.id, row.title]));
  const sources = documentIds.map((documentId) => {
    const extraction = byDocument.get(documentId);
    if (!extraction || extraction.status !== "succeeded" || !extraction.text) {
      throw new QuizGenerationError("no_extraction", "Every selected source must have a succeeded extraction.");
    }
    return {
      documentId,
      extractionId: extraction.extractionId,
      text: extraction.text,
      title: byTitle.get(documentId)!,
    };
  });
  return sources;
}

async function recordFailedQuiz(
  auth: AuthContext,
  input: {
    notebookId?: string;
    documentId: string;
    sourceExtractionId: string;
    sourceManifest: QuizSourceSnapshot[];
    generationKey?: string;
    title: string;
    model: string;
    error: string;
  },
) {
  await db.insert(quizzes).values({
    workspaceId: auth.workspaceId,
    notebookId: input.notebookId,
    documentId: input.documentId,
    // Generation only runs when a succeeded extraction exists, so a failed
    // row can always pin the extraction it ran against.
    sourceExtractionId: input.sourceExtractionId,
    sourceManifest: input.sourceManifest,
    generationKey: input.generationKey,
    title: input.title.slice(0, MAX_QUIZ_TITLE_CHARS),
    status: "failed",
    questionCount: 0,
    model: input.model,
    promptVersion: QUIZ_PROMPT_VERSION,
    error: input.error.slice(0, MAX_ERROR_CHARS),
    createdBy: auth.userId,
    updatedBy: auth.userId,
  });
}

/**
 * Generate a quiz from the selected sources' current succeeded extractions
 * and persist it in one transaction. `questionCount` is an exact request from
 * MIN_ITEM_COUNT to MAX_ITEM_COUNT; omitted, it scales with the sources
 * (defaultItemCount). Questions are made in batches without repeats, and the
 * quiz is written once at the end: grading needs every question answered, so
 * a quiz never grows after someone can sit it. Returns the questions stored,
 * the count requested and why the run stopped (GenerationOutcome), so the
 * surface can tell sources that support no more from a later batch that
 * failed; a replay returns the stored values. A generation that cannot prove at least
 * MIN_QUIZ_QUESTIONS questions writes a `failed` row with the typed error so
 * the surface can say something honest; a document with no succeeded
 * extraction throws before anything is written.
 */
export async function generateQuiz(
  auth: AuthContext,
  input: {
    notebookId?: string;
    documentId: string;
    documentIds?: string[];
    questionCount?: number;
    idempotencyKey?: string;
  },
  generator?: QuizGenerator,
): Promise<{
  quizId: string;
  questionCount: number;
  droppedQuestions: number;
  requested: number;
  stoppedBy: GenerationOutcome;
}> {
  const selectedIds = input.documentIds ?? [input.documentId];
  if (selectedIds[0] !== input.documentId) {
    throw new QuizGenerationError(
      "invalid_sources",
      "The first source must match the notebook's selected source order.",
    );
  }
  if (
    input.questionCount !== undefined &&
    (!Number.isInteger(input.questionCount) ||
      input.questionCount < MIN_ITEM_COUNT ||
      input.questionCount > MAX_ITEM_COUNT)
  ) {
    throw new QuizGenerationError(
      "invalid_sources",
      `Choose between ${MIN_ITEM_COUNT} and ${MAX_ITEM_COUNT} questions.`,
    );
  }
  const sources = await loadCurrentQuizSources(auth, selectedIds);
  const primary = sources[0];
  const manifest: QuizSourceSnapshot[] = sources.map(({ documentId, extractionId, title }) => ({
    documentId,
    extractionId,
    title,
  }));
  const title = sources.length === 1 ? primary.title : `${primary.title} + ${sources.length - 1} more`;
  if (input.idempotencyKey) {
    const [existing] = await db
      .select({
        id: quizzes.id,
        status: quizzes.status,
        questionCount: quizzes.questionCount,
        error: quizzes.error,
        sourceManifest: quizzes.sourceManifest,
        notebookId: quizzes.notebookId,
        requestedCount: quizzes.requestedCount,
        stoppedBy: quizzes.stoppedBy,
      })
      .from(quizzes)
      .where(and(eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.generationKey, input.idempotencyKey)))
      .limit(1);
    if (existing) {
      if (
        existing.notebookId !== (input.notebookId ?? null) ||
        !sameSourceVersions(existing.sourceManifest, manifest)
      ) {
        throw new QuizGenerationError(
          "invalid_sources",
          "This quiz request key already belongs to a different source selection.",
        );
      }
      if (existing.status === "ready") {
        return {
          quizId: existing.id,
          questionCount: existing.questionCount,
          droppedQuestions: 0,
          // Quizzes made before counts were recorded read as complete.
          requested: existing.requestedCount ?? existing.questionCount,
          stoppedBy: existing.stoppedBy ?? "complete",
        };
      }
      throw new QuizGenerationError("generation_failed", existing.error ?? GENERATION_COPY.generation_failed);
    }
  }

  // Provider setup happens after source validation, so a missing key never
  // creates a failed quiz row for an invalid or unready source selection.
  const engine = generator ?? defaultQuizGenerator(auth.workspaceId);
  const learningContext = await quizGenerationContext(auth, selectedIds);
  const questionCount =
    input.questionCount ?? defaultItemCount(sources.reduce((sum, source) => sum + source.text.length, 0));

  let proposedQuestions = 0;
  let droppedQuestions = 0;
  async function proposeVerifiedQuestions(count: number, avoidPrompts: string[], part: number) {
    const options = { questionCount: count, learningContext, avoidPrompts, part };
    let raw: { questions: GeneratedQuestion[] };
    if (sources.length === 1) {
      raw = await engine.generate(primary.text, options);
    } else if (engine.generateFromSources) {
      raw = await engine.generateFromSources(
        sources.map(({ title, text }) => ({ title, text })),
        options,
      );
    } else {
      throw new Error("This quiz generator does not support multiple sources.");
    }
    const verified = verifyQuizAcrossSources(sources, raw.questions, count);
    proposedQuestions += raw.questions.length;
    droppedQuestions += verified.droppedQuestions;
    return verified.questions;
  }

  let questions: VerifiedQuestion[];
  let stoppedBy: GenerationOutcome;
  try {
    ({ items: questions, stoppedBy } = await generateInBatches(questionCount, proposeVerifiedQuestions));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Quiz generation failed.";
    await recordFailedQuiz(auth, {
      notebookId: input.notebookId,
      documentId: primary.documentId,
      title,
      model: engine.name,
      error: GENERATION_COPY.generation_failed,
      sourceExtractionId: primary.extractionId,
      sourceManifest: manifest,
      generationKey: input.idempotencyKey,
    });
    throw new QuizGenerationError("generation_failed", message);
  }

  if (questions.length < MIN_QUIZ_QUESTIONS) {
    const message = `Only ${questions.length} of ${proposedQuestions} proposed questions could be verified against selected source text; a quiz needs at least ${MIN_QUIZ_QUESTIONS}.`;
    await recordFailedQuiz(auth, {
      notebookId: input.notebookId,
      documentId: primary.documentId,
      title,
      model: engine.name,
      error: message,
      sourceExtractionId: primary.extractionId,
      sourceManifest: manifest,
      generationKey: input.idempotencyKey,
    });
    throw new QuizGenerationError("insufficient_evidence", message);
  }

  const quiz = await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(quizzes)
      .values({
        workspaceId: auth.workspaceId,
        notebookId: input.notebookId,
        documentId: primary.documentId,
        sourceExtractionId: primary.extractionId,
        sourceManifest: manifest,
        generationKey: input.idempotencyKey,
        title: title.slice(0, MAX_QUIZ_TITLE_CHARS),
        status: "ready",
        questionCount: questions.length,
        requestedCount: questionCount,
        stoppedBy,
        model: engine.name,
        promptVersion: QUIZ_PROMPT_VERSION,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: quizzes.id });
    await tx.insert(quizQuestions).values(
      questions.map((q, i) => ({
        workspaceId: auth.workspaceId,
        quizId: row.id,
        ordinal: i,
        prompt: q.prompt,
        choices: q.choices,
        answerValue: q.answerValue,
        explanation: q.explanation,
        evidence: q.evidence,
      })),
    );
    await recordAudit(
      auth,
      {
        action: "learning.quiz_generated",
        subjectType: "quiz",
        subjectId: row.id,
        summary: `Generated a ${questions.length}-question quiz from ${sources.length} source${sources.length === 1 ? "" : "s"}`,
        metadata: {
          documentIds: selectedIds,
          sourceCount: manifest.length,
          droppedQuestions,
          requested: questionCount,
          stoppedBy,
          model: engine.name,
          promptVersion: QUIZ_PROMPT_VERSION,
        },
      },
      tx,
    );
    return row;
  });

  return { quizId: quiz.id, questionCount: questions.length, droppedQuestions, requested: questionCount, stoppedBy };
}
