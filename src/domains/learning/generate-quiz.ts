import { and, eq, sql } from "drizzle-orm";
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
import { quizzes, quizQuestions } from "./schema";

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

export const MIN_QUIZ_QUESTIONS = 3;
export const MAX_QUIZ_QUESTIONS = 6;
const MAX_PROMPT_CHARS = 300;
const MAX_CHOICE_LABEL_CHARS = 200;
const MAX_CHOICE_VALUE_CHARS = 60;
const MAX_EVIDENCE_QUOTE_CHARS = 400;
const MAX_EXPLANATION_CHARS = 800;
const MAX_QUIZ_TITLE_CHARS = 200;
const MAX_ERROR_CHARS = 500;

export class QuizGenerationError extends Error {
  constructor(
    public readonly code: "document_not_found" | "no_extraction" | "insufficient_evidence" | "generation_failed",
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
  insufficient_evidence: "Not enough of this document could be verified against its text to build an honest quiz.",
  generation_failed: "The quiz generator did not answer. Try again in a moment.",
};

export type VerifiedQuestion = {
  prompt: string;
  choices: Array<{ value: string; label: string }>;
  answerValue: string;
  explanation: string;
  evidence: { quote: string; startOffset: number; endOffset: number };
};

export type VerifiedQuiz = {
  questions: VerifiedQuestion[];
  /** Questions the model offered but could not prove against the text. */
  droppedQuestions: number;
};

/*
 * Pure trust boundary between the model's proposal and a persistable quiz.
 * A question survives only when: the prompt is non-empty, choices number
 * 2-5 with unique non-empty values, answerValue names one of those values,
 * the explanation is non-empty, and the quote re-locates in the text
 * (normalized matching - formatting-tolerant, content-strict, see
 * locate-quote.ts). Everything else is dropped and counted, never repaired.
 */
export function verifyQuiz(text: string, raw: GeneratedQuestion[]): VerifiedQuiz {
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
    if (questions.length >= MAX_QUIZ_QUESTIONS) break;
  }
  return { questions, droppedQuestions };
}

async function loadCurrentExtraction(auth: AuthContext, documentId: string) {
  // Two distinct honest failures: a document that does not exist (or is not
  // ours) is not the same as one still being read. One join would report
  // "no such document" about a document the user captured minutes ago.
  const [doc] = await db
    .select({ title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) throw new QuizGenerationError("document_not_found", "No such document.");

  const [extraction] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text, status: documentExtractions.status })
    .from(documents)
    .innerJoin(documentExtractions, eq(documentExtractions.documentId, documents.id))
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.workspaceId, auth.workspaceId),
        // Correlates against documents: currentExtractionIdSubquery resolves
        // the document's active extraction, falling back to its newest row.
        eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
      ),
    )
    .limit(1);
  if (!extraction || extraction.status !== "succeeded" || !extraction.text) {
    throw new QuizGenerationError("no_extraction", "This document has no succeeded extraction to quiz yet.");
  }
  return { id: extraction.id, text: extraction.text, title: doc.title };
}

async function recordFailedQuiz(
  auth: AuthContext,
  input: { documentId: string; sourceExtractionId: string; title: string; model: string; error: string },
) {
  await db.insert(quizzes).values({
    workspaceId: auth.workspaceId,
    documentId: input.documentId,
    // Generation only runs when a succeeded extraction exists, so a failed
    // row can always pin the extraction it ran against.
    sourceExtractionId: input.sourceExtractionId,
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
 * Generate a quiz from a document's current succeeded extraction and persist
 * it in one transaction. A generation that cannot prove at least
 * MIN_QUIZ_QUESTIONS questions writes a `failed` row with the typed error so
 * the surface can say something honest; a document with no succeeded
 * extraction throws before anything is written.
 */
export async function generateQuiz(
  auth: AuthContext,
  input: { documentId: string },
  generator?: QuizGenerator,
): Promise<{ quizId: string; questionCount: number; droppedQuestions: number }> {
  const extraction = await loadCurrentExtraction(auth, input.documentId);

  // defaultQuizGenerator throws EmbeddingUnconfiguredError synchronously when
  // no provider is configured - a workspace setting, not a quiz attempt, so
  // it propagates here without writing a failed row per click.
  const engine = generator ?? defaultQuizGenerator(auth.workspaceId);

  let raw: { questions: GeneratedQuestion[] };
  try {
    raw = await engine.generate(extraction.text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Quiz generation failed.";
    await recordFailedQuiz(auth, {
      documentId: input.documentId,
      title: extraction.title,
      model: engine.name,
      // The row stores the authored sentence, not the driver's text: the
      // schema promises an owner-facing failure reason.
      error: GENERATION_COPY.generation_failed,
      sourceExtractionId: extraction.id,
    });
    throw new QuizGenerationError("generation_failed", message);
  }

  const verified = verifyQuiz(extraction.text, raw.questions);
  if (verified.questions.length < MIN_QUIZ_QUESTIONS) {
    const message = `Only ${verified.questions.length} of ${raw.questions.length} proposed questions could be verified against the text; a quiz needs at least ${MIN_QUIZ_QUESTIONS}.`;
    await recordFailedQuiz(auth, {
      documentId: input.documentId,
      title: extraction.title,
      model: engine.name,
      error: message,
      sourceExtractionId: extraction.id,
    });
    throw new QuizGenerationError("insufficient_evidence", message);
  }

  const quiz = await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(quizzes)
      .values({
        workspaceId: auth.workspaceId,
        documentId: input.documentId,
        sourceExtractionId: extraction.id,
        title: extraction.title.slice(0, MAX_QUIZ_TITLE_CHARS),
        status: "ready",
        questionCount: verified.questions.length,
        model: engine.name,
        promptVersion: QUIZ_PROMPT_VERSION,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: quizzes.id });
    await tx.insert(quizQuestions).values(
      verified.questions.map((q, i) => ({
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
        summary: `Generated a ${verified.questions.length}-question quiz from "${extraction.title}"`,
        metadata: {
          documentId: input.documentId,
          droppedQuestions: verified.droppedQuestions,
          model: engine.name,
          promptVersion: QUIZ_PROMPT_VERSION,
        },
      },
      tx,
    );
    return row;
  });

  return { quizId: quiz.id, questionCount: verified.questions.length, droppedQuestions: verified.droppedQuestions };
}
