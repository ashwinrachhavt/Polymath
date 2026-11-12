import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";
import { artifacts, documentExtractions, documents, notebooks } from "../knowledge/schema";
import { users } from "../identity/schema";
import type { GenerationOutcome } from "./item-count";

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
export type QuizEvidence = {
  quote: string;
  startOffset: number;
  endOffset: number;
  /** Present on multi-source sessions; omitted on historical single-source rows. */
  source?: { documentId: string; extractionId: string; title: string };
};

export type QuizSourceSnapshot = {
  documentId: string;
  extractionId: string;
  title: string;
  /** The source was chosen but no question was asked of it: it is an index of links, with nothing explained. */
  skipped?: true;
};

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
    notebookId: uuid("notebook_id").references(() => notebooks.id, { onDelete: "set null" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceExtractionId: uuid("source_extraction_id")
      .notNull()
      .references(() => documentExtractions.id, { onDelete: "cascade" }),
    /** Immutable document and extraction versions selected for this sitting. */
    sourceManifest: jsonb("source_manifest").$type<QuizSourceSnapshot[]>().notNull().default([]),
    /** Client intent key prevents a completed retry from creating a second quiz. */
    generationKey: text("generation_key"),
    title: text("title").notNull(),
    status: quizStatus("status").notNull(),
    /** 0 for a failed generation; the question count otherwise. */
    questionCount: integer("question_count").notNull().default(0),
    /** The generator seam's name, e.g. "openrouter:openai/gpt-4o-mini". */
    model: text("model"),
    promptVersion: text("prompt_version"),
    /** Authored, honest failure reason for a failed generation. */
    error: text("error"),
    /** The question count asked for; null on failed rows and quizzes made before counts were recorded. */
    requestedCount: integer("requested_count"),
    /** Why generation ended for a ready quiz; null on failed rows and quizzes made before. */
    stoppedBy: text("stopped_by").$type<GenerationOutcome>(),
    ...mutable,
  },
  (t) => [
    index("quizzes_document_idx").on(t.workspaceId, t.documentId, t.createdAt),
    uniqueIndex("quizzes_generation_key").on(t.workspaceId, t.generationKey),
    check("quizzes_stopped_by_check", sql`"stopped_by" in ('complete', 'source_exhausted', 'batch_failed')`),
  ],
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

/** Immutable source versions that informed one on-demand flashcard deck. */
export type FlashcardSourceSnapshot = { documentId: string; extractionId: string; title: string };
export type FlashcardEvidence = {
  quote: string;
  startOffset: number;
  endOffset: number;
  source: FlashcardSourceSnapshot;
};

export const flashcardDecks = pgTable(
  "flashcard_decks",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** The Notebook the deck was made in; null for a deck made from sources picked on Learn or in the inbox. */
    notebookId: uuid("notebook_id").references(() => notebooks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceManifest: jsonb("source_manifest").$type<FlashcardSourceSnapshot[]>().notNull(),
    generationKey: text("generation_key").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** The card count asked for; null on decks made before counts were recorded. */
    requestedCount: integer("requested_count"),
    /**
     * Why generation ended. Null while batches are still adding cards (or if
     * the run died mid-way); the cards already stored are usable either way.
     */
    stoppedBy: text("stopped_by").$type<GenerationOutcome>(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("flashcard_decks_generation_key").on(t.workspaceId, t.generationKey),
    check("flashcard_decks_stopped_by_check", sql`"stopped_by" in ('complete', 'source_exhausted', 'batch_failed')`),
    index("flashcard_decks_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const flashcards = pgTable(
  "flashcards",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    deckId: uuid("deck_id")
      .notNull()
      .references(() => flashcardDecks.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    answer: text("answer").notNull(),
    evidence: jsonb("evidence").$type<FlashcardEvidence>().notNull(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("flashcards_deck_ordinal_key").on(t.deckId, t.ordinal),
    index("flashcards_workspace_deck_idx").on(t.workspaceId, t.deckId),
  ],
);

/** Scheduling is private to each learner; card content is shared. */
export const flashcardReviews = pgTable(
  "flashcard_reviews",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    flashcardId: uuid("flashcard_id")
      .notNull()
      .references(() => flashcards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    intervalDays: integer("interval_days").notNull().default(0),
    easeHundredths: integer("ease_hundredths").notNull().default(250),
    repetitions: integer("repetitions").notNull().default(0),
    lastRating: text("last_rating").$type<"again" | "hard" | "good" | "easy">(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("flashcard_reviews_user_card_key").on(t.workspaceId, t.flashcardId, t.userId),
    index("flashcard_reviews_due_idx").on(t.workspaceId, t.userId, t.dueAt),
    check(
      "flashcard_reviews_schedule_check",
      sql.raw("interval_days >= 0 and ease_hundredths between 130 and 350 and repetitions >= 0"),
    ),
    check(
      "flashcard_reviews_rating_check",
      sql.raw("last_rating is null or last_rating in ('again', 'hard', 'good', 'easy')"),
    ),
  ],
);

/** Source pins for a guided explanation session. */
export type ExplainSourceSnapshot = { documentId: string; extractionId: string; title: string };
export type ExplainEvidence = { quote: string; startOffset: number; endOffset: number; source: ExplainSourceSnapshot };

export const explainSessions = pgTable(
  "explain_sessions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    notebookId: uuid("notebook_id")
      .notNull()
      .references(() => notebooks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceManifest: jsonb("source_manifest").$type<ExplainSourceSnapshot[]>().notNull(),
    generationKey: text("generation_key").notNull(),
    status: text("status").$type<"active" | "completed">().notNull().default("active"),
    questionLimit: integer("question_limit").notNull().default(5),
    ...mutable,
  },
  (t) => [
    uniqueIndex("explain_sessions_generation_key").on(t.workspaceId, t.userId, t.generationKey),
    index("explain_sessions_notebook_user_idx").on(t.workspaceId, t.notebookId, t.userId, t.updatedAt),
    check("explain_sessions_status_check", sql.raw("status in ('active', 'completed')")),
    check("explain_sessions_limit_check", sql.raw("question_limit between 1 and 5")),
  ],
);

export const explainTurns = pgTable(
  "explain_turns",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => explainSessions.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    answer: text("answer"),
    grade: text("grade").$type<"correct" | "partial" | "incorrect" | "uncertain">(),
    feedback: text("feedback"),
    evidence: jsonb("evidence").$type<ExplainEvidence[]>().notNull().default([]),
    ...mutable,
  },
  (t) => [
    uniqueIndex("explain_turns_session_ordinal_key").on(t.sessionId, t.ordinal),
    index("explain_turns_workspace_session_idx").on(t.workspaceId, t.sessionId, t.ordinal),
    check(
      "explain_turns_grade_check",
      sql.raw("grade is null or grade in ('correct', 'partial', 'incorrect', 'uncertain')"),
    ),
  ],
);

/** Recall attempts are learner outcomes, separate from the verified graph edges. */
export const graphRecallAttempts = pgTable(
  "graph_recall_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    notebookId: uuid("notebook_id")
      .notNull()
      .references(() => notebooks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceArtifactId: uuid("source_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    targetArtifactId: uuid("target_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    expectedRelation: text("expected_relation").notNull(),
    submittedRelation: text("submitted_relation").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    requestKey: text("request_key").notNull(),
    ...recorded,
  },
  (t) => [
    uniqueIndex("graph_recall_attempts_request_key").on(t.workspaceId, t.userId, t.requestKey),
    index("graph_recall_attempts_notebook_user_idx").on(t.workspaceId, t.notebookId, t.userId, t.createdAt),
    check("graph_recall_attempts_distinct_cards", sql.raw("source_artifact_id <> target_artifact_id")),
  ],
);

/** One user's rating for a generated artifact, quiz, or flashcard deck. */
export const learningArtifactFeedback = pgTable(
  "artifact_feedback",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "cascade" }),
    quizId: uuid("quiz_id").references(() => quizzes.id, { onDelete: "cascade" }),
    flashcardDeckId: uuid("flashcard_deck_id").references(() => flashcardDecks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: text("rating").$type<"helpful" | "not_helpful">().notNull(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("artifact_feedback_artifact_user_key")
      .on(t.workspaceId, t.artifactId, t.userId)
      .where(sql`${t.artifactId} is not null`),
    uniqueIndex("artifact_feedback_quiz_user_key")
      .on(t.workspaceId, t.quizId, t.userId)
      .where(sql`${t.quizId} is not null`),
    uniqueIndex("artifact_feedback_flashcard_deck_user_key")
      .on(t.workspaceId, t.flashcardDeckId, t.userId)
      .where(sql`${t.flashcardDeckId} is not null`),
    check("artifact_feedback_target_check", sql`num_nonnulls(${t.artifactId}, ${t.quizId}, ${t.flashcardDeckId}) = 1`),
    check("artifact_feedback_rating_check", sql`${t.rating} in ('helpful', 'not_helpful')`),
    index("artifact_feedback_workspace_user_idx").on(t.workspaceId, t.userId, t.updatedAt),
  ],
);

export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
