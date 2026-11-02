import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";
import { documentExtractions, documents } from "../knowledge/schema";
import { users } from "../identity/schema";

/*
 * The learning domain (learn-harness replication): a captured document's
 * succeeded extraction becomes a short graded quiz, and completing a quiz
 * earns a stone through the gamification ledger. The generation discipline
 * is the reading summary's (ASH-292): the model proposes, the domain
 * disposes - a question survives only when its evidence quote is a verbatim
 * passage of the exact extraction it claims to describe.
 */

/** A quiz is generated synchronously: ready, or failed with the reason. */
export const quizStatus = pgEnum("quiz_status", ["ready", "failed"]);

/** One option of a graded question. `value` is the grading anchor. */
export type QuizChoice = { value: string; label: string };

/** The verbatim span of the source extraction that grounds a question. */
export type QuizEvidence = { quote: string; startOffset: number; endOffset: number };

/** One answered question. `dontKnow` is a distinct signal, never a wrong guess. */
export type SubmittedAnswer = {
  questionId: string;
  /** null when the submitter chose "I don't know" (or sent nothing). */
  selectedValue: string | null;
  dontKnow: boolean;
};

/*
 * Versioned: regenerating a document's quiz creates a new row and the
 * surface shows the latest ready one - no in-place edits, no pending state.
 * `sourceExtractionId` pins the version the questions were verified against,
 * so a question's evidence is always checkable against its own text.
 */
export const quizzes = pgTable(
  "quizzes",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceExtractionId: uuid("source_extraction_id")
      .notNull()
      .references(() => documentExtractions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: quizStatus("status").notNull(),
    /** 0 for a failed generation; the question count otherwise. */
    questionCount: integer("question_count").notNull().default(0),
    /** The generator seam's name, e.g. "openrouter:openai/gpt-4o-mini". */
    model: text("model"),
    promptVersion: text("prompt_version"),
    /** Authored, honest failure reason for a failed generation. */
    error: text("error"),
    ...mutable,
  },
  (t) => [index("quizzes_document_idx").on(t.workspaceId, t.documentId, t.createdAt)],
);

/*
 * Append-only: a quiz's questions never change after generation. Grading is
 * value-keyed - `answerValue` names the correct choice's `value`, so a
 * display-order shuffle cannot corrupt a score and a typo is a hard
 * verification error, not a silent wrong grade.
 */
export const quizQuestions = pgTable(
  "quiz_questions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    choices: jsonb("choices").$type<QuizChoice[]>().notNull(),
    answerValue: text("answer_value").notNull(),
    /** Revealed only after answering. Required, never null. */
    explanation: text("explanation").notNull(),
    evidence: jsonb("evidence").$type<QuizEvidence>().notNull(),
    ...recorded,
  },
  (t) => [uniqueIndex("quiz_questions_ordinal_key").on(t.quizId, t.ordinal)],
);

/*
 * Append-only and written once, at completion - mid-quiz state is client-only
 * in v1. The unique key makes a replayed attempt intent a read of the
 * original row instead of a second sitting, and the award rides the same
 * transaction, so "exactly one stone per attempt" is a database fact.
 */
export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    answers: jsonb("answers").$type<SubmittedAnswer[]>().notNull(),
    /** Graded server-side; a client-supplied score is never persisted. */
    correctCount: integer("correct_count").notNull(),
    totalCount: integer("total_count").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("quiz_attempts_idempotency_key").on(t.workspaceId, t.idempotencyKey),
    index("quiz_attempts_quiz_user_idx").on(t.quizId, t.userId),
  ],
);

export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
