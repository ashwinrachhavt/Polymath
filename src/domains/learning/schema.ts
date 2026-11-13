import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
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
import { artifacts, concepts, documentExtractions, documents, notebooks } from "../knowledge/schema";
import { users } from "../identity/schema";
import type { ChallengeContent, ChallengeFormat } from "./challenge-content";
import type { ChallengeGrade } from "./challenge-grading";
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

/**
 * The one spaced-repetition schedule, private to each learner (item content is
 * shared). A row schedules exactly one item: a flashcard or a quiz question.
 * The table kept its first name; it is the review model for every item kind,
 * and `review-schedule.ts` is the one place a rating becomes a due date.
 */
export const flashcardReviews = pgTable(
  "flashcard_reviews",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    flashcardId: uuid("flashcard_id").references(() => flashcards.id, { onDelete: "cascade" }),
    quizQuestionId: uuid("quiz_question_id").references(() => quizQuestions.id, { onDelete: "cascade" }),
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
    uniqueIndex("flashcard_reviews_user_question_key").on(t.workspaceId, t.quizQuestionId, t.userId),
    check("flashcard_reviews_one_item_check", sql`num_nonnulls("flashcard_id", "quiz_question_id") = 1`),
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

/*
 * What a question, card or explanation is about. One row links one concept
 * (the knowledge dictionary entry an Idea also upserts) to exactly one item;
 * an item about two concepts has two rows. Generation writes the rows with the
 * item, in the same transaction. Items made before this table have none, and
 * every reader treats a missing link as "unassessed", never as a wrong answer.
 */
export const conceptLinks = pgTable(
  "concept_links",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    conceptId: uuid("concept_id").notNull(),
    quizQuestionId: uuid("quiz_question_id").references(() => quizQuestions.id, { onDelete: "cascade" }),
    flashcardId: uuid("flashcard_id").references(() => flashcards.id, { onDelete: "cascade" }),
    explainTurnId: uuid("explain_turn_id").references(() => explainTurns.id, { onDelete: "cascade" }),
    ...recorded,
  },
  (t) => [
    // Composite, so a link can never name another workspace's concept.
    foreignKey({
      name: "concept_links_concept_same_workspace_fk",
      columns: [t.workspaceId, t.conceptId],
      foreignColumns: [concepts.workspaceId, concepts.id],
    }).onDelete("cascade"),
    check(
      "concept_links_one_subject_check",
      sql`num_nonnulls("quiz_question_id", "flashcard_id", "explain_turn_id") = 1`,
    ),
    uniqueIndex("concept_links_quiz_question_key").on(t.quizQuestionId, t.conceptId),
    uniqueIndex("concept_links_flashcard_key").on(t.flashcardId, t.conceptId),
    uniqueIndex("concept_links_explain_turn_key").on(t.explainTurnId, t.conceptId),
    index("concept_links_concept_idx").on(t.workspaceId, t.conceptId),
  ],
);

/*
 * Practice challenges (Predict, Bug Hunt and later formats). One pair of
 * tables for every format: the format's own fields live in `content`, a
 * discriminated union parsed by `challenge-content.ts`, never in a table of
 * their own. A challenge is made off the request, so it is `preparing` until
 * its content is stored, and is then replayed from that content alone.
 */
export const learningChallenges = pgTable(
  "learning_challenges",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    notebookId: uuid("notebook_id")
      .notNull()
      .references(() => notebooks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    format: text("format").$type<ChallengeFormat>().notNull(),
    status: text("status").$type<"preparing" | "ready" | "failed">().notNull().default("preparing"),
    sourceManifest: jsonb("source_manifest").$type<ExplainSourceSnapshot[]>().notNull(),
    generationKey: text("generation_key").notNull(),
    /** What the challenge shows the learner can do; a concept link can attach to it later. */
    objective: text("objective"),
    content: jsonb("content").$type<ChallengeContent>(),
    /** The source passage the challenge rests on, located in the pinned extraction. */
    evidence: jsonb("evidence").$type<ExplainEvidence[]>().notNull().default([]),
    promptVersion: text("prompt_version"),
    /** Why preparing failed, in words the learner can read. */
    error: text("error"),
    /** Hints shown since the last submitted attempt. */
    hintsShown: integer("hints_shown").notNull().default(0),
    ...mutable,
  },
  (t) => [
    uniqueIndex("learning_challenges_generation_key").on(t.workspaceId, t.userId, t.generationKey),
    index("learning_challenges_notebook_user_idx").on(t.workspaceId, t.notebookId, t.userId, t.createdAt),
    check("learning_challenges_format_check", sql.raw("format in ('predict', 'bug_hunt')")),
    check("learning_challenges_status_check", sql.raw("status in ('preparing', 'ready', 'failed')")),
    check("learning_challenges_ready_check", sql.raw("status <> 'ready' or content is not null")),
    check("learning_challenges_hints_check", sql.raw("hints_shown between 0 and 3")),
  ],
);

/** One committed answer. Written once: a retry is a new row with the next ordinal. */
export const learningChallengeAttempts = pgTable(
  "learning_challenge_attempts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => learningChallenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    /** The client's key for this submit; a repeat returns the stored attempt. */
    submitKey: text("submit_key").notNull(),
    answer: text("answer").notNull(),
    /** The learner said "I don't know": an honest gap, never graded as a wrong guess. */
    dontKnow: boolean("dont_know").notNull().default(false),
    hintsUsed: integer("hints_used").notNull().default(0),
    /** Null only for "I don't know". */
    grade: text("grade").$type<ChallengeGrade>(),
    /** The step feedback names; null when every step was met. */
    failedStep: text("failed_step"),
    feedback: text("feedback").notNull(),
    /** Whether the rules decided, or the model was asked because they could not. */
    gradedBy: text("graded_by").$type<"rules" | "model">().notNull(),
    evidence: jsonb("evidence").$type<ExplainEvidence[]>().notNull().default([]),
    ...recorded,
  },
  (t) => [
    uniqueIndex("learning_challenge_attempts_ordinal_key").on(t.challengeId, t.ordinal),
    uniqueIndex("learning_challenge_attempts_submit_key").on(t.workspaceId, t.userId, t.submitKey),
    check(
      "learning_challenge_attempts_grade_check",
      sql.raw("grade is null or grade in ('correct', 'partial', 'incorrect', 'uncertain')"),
    ),
    check("learning_challenge_attempts_dont_know_check", sql.raw("(grade is null) = dont_know")),
    check("learning_challenge_attempts_graded_by_check", sql.raw("graded_by in ('rules', 'model')")),
    check("learning_challenge_attempts_hints_check", sql.raw("hints_used between 0 and 3")),
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

/*
 * A Mission: what someone must be able to do, by when, from named sources.
 * A Mission without a date is a draft; a dated one is the thing the buyer
 * pays for (payment itself is not built here). The concept list is written
 * by a background job and then edited by its owner before the Mission starts:
 * `mission_concepts` is the plan, `mission_mock_sessions` and
 * `mission_mock_answers` are the unaided proof.
 *
 * A concept choice always names the source passage it came from. A proposal
 * with no locatable source is dropped, exactly like an unproven quiz question,
 * so the plan can never invent work on material the person did not bring.
 */
export const missionStatus = pgEnum("mission_status", ["draft", "active", "archived"]);

export const missions = pgTable(
  "missions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** One plain sentence: what the person must be able to do. */
    goal: text("goal").notNull(),
    /** Optional: the role or performance being prepared for. */
    role: text("role"),
    /** The day it must be performed. A Mission with a date is the paid one. */
    dueOn: date("due_on", { mode: "string" }),
    status: missionStatus("status").notNull().default("draft"),
    /** The sources the concept list was drawn from, pinned by title. */
    sourceManifest: jsonb("source_manifest").$type<MissionSourceSnapshot[]>().notNull().default([]),
    /**
     * The concept job this Mission is waiting on or failed on; null once it
     * has concepts. `mission.job` is a generation job kind, so the wait and
     * its retry are the shared outbox path, not a second queue.
     */
    conceptJobId: uuid("concept_job_id"),
    /**
     * The submitter's intent key: a double-click or a resend after a reload
     * returns the Mission already made, never a second one. Unique per
     * workspace, so the click is one row at most.
     */
    requestKey: text("request_key").notNull(),
    ...mutable,
  },
  (t) => [
    uniqueIndex("missions_request_key").on(t.workspaceId, t.requestKey),
    index("missions_workspace_status_idx").on(t.workspaceId, t.status, t.createdAt),
    check("missions_goal_check", sql`length(btrim("goal")) between 1 and 500`),
    check("missions_role_check", sql`"role" is null or length("role") <= 2000`),
  ],
);

/** A library document and exact extraction version a Mission's plan was drawn from. */
export type MissionSourceSnapshot = { documentId: string; extractionId: string; title: string };

export const missionConcepts = pgTable(
  "mission_concepts",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id").notNull(),
    /** Where this concept sits in the plan; the mock asks in this order. */
    ordinal: integer("ordinal").notNull(),
    /** One line, in the model's words, saying why this concept matters for the goal. */
    reason: text("reason").notNull(),
    /** The verbatim passage the concept was drawn from; null for one the owner added by hand. */
    sourceQuote: text("source_quote"),
    /** The library document the passage came from; null for a hand-added concept. */
    sourceDocumentId: uuid("source_document_id"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("mission_concepts_ordinal_key").on(t.missionId, t.ordinal),
    uniqueIndex("mission_concepts_concept_key").on(t.missionId, t.conceptId),
    foreignKey({
      name: "mission_concepts_concept_same_workspace_fk",
      columns: [t.workspaceId, t.conceptId],
      foreignColumns: [concepts.workspaceId, concepts.id],
    }).onDelete("cascade"),
    index("mission_concepts_mission_idx").on(t.workspaceId, t.missionId, t.ordinal),
  ],
);

/**
 * One unaided sitting of a Mission: free-response questions over its
 * concepts, answered with nothing in front of the learner. The model writes
 * the questions when the sitting opens and grades each answer against the
 * same pinned sources Explain It uses; an uncertain grade stays uncertain.
 */
export const missionMockSessions = pgTable(
  "mission_mock_sessions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The client's key: a double-click opens one sitting, never two. */
    requestKey: text("request_key").notNull(),
    /** Where the sitting stands: questions being written, being answered, or finished and reportable. */
    status: text("status").$type<"preparing" | "asking" | "complete">().notNull().default("preparing"),
    /** Why preparing failed, in words the person can read; null otherwise. */
    error: text("error"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("mission_mock_sessions_request_key").on(t.workspaceId, t.userId, t.requestKey),
    index("mission_mock_sessions_mission_user_idx").on(t.workspaceId, t.missionId, t.userId, t.createdAt),
    check("mission_mock_sessions_status_check", sql.raw("status in ('preparing', 'asking', 'complete')")),
  ],
);

/**
 * One question of a mock sitting. `conceptId` names the Mission concept it
 * tests, so a report can be read per concept without joining through the
 * generic concept link. The answer is stored exactly as written; `grade` is
 * null until it is submitted, and may be `uncertain` - which never counts as
 * proven.
 */
export const missionMockQuestions = pgTable(
  "mission_mock_questions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => missionMockSessions.id, { onDelete: "cascade" }),
    missionConceptId: uuid("mission_concept_id")
      .notNull()
      .references(() => missionConcepts.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    /** The source passages the question rests on and the feedback cites. */
    evidence: jsonb("evidence").$type<ExplainEvidence[]>().notNull().default([]),
    answer: text("answer"),
    grade: text("grade").$type<"correct" | "partial" | "incorrect" | "uncertain">(),
    feedback: text("feedback"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("mission_mock_questions_ordinal_key").on(t.sessionId, t.ordinal),
    index("mission_mock_questions_session_idx").on(t.workspaceId, t.sessionId, t.ordinal),
    index("mission_mock_questions_concept_idx").on(t.workspaceId, t.missionConceptId),
    check(
      "mission_mock_questions_grade_check",
      sql.raw("grade is null or grade in ('correct', 'partial', 'incorrect', 'uncertain')"),
    ),
    check("mission_mock_questions_answer_check", sql.raw("(answer is null) = (grade is null)")),
  ],
);

export type Mission = typeof missions.$inferSelect;
export type MissionConcept = typeof missionConcepts.$inferSelect;
export type MissionMockQuestion = typeof missionMockQuestions.$inferSelect;
