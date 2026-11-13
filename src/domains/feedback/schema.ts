import { sql } from "drizzle-orm";
import { check, index, pgTable, smallint, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";
import { agentRuns, runEvents } from "../agents/schema";
import { users } from "../identity/schema";
import { artifacts } from "../knowledge/schema";
import { explainTurns, flashcardDecks, quizzes } from "../learning/schema";

/*
 * One person's rating of one model output. Every surface that shows generated
 * text rates it here: a chat reply (the run_event it was written to), a whole
 * run, a quiz, a flashcard deck, an Explain It verdict, an artifact.
 *
 * The scale is 1-5 (😞 to 😄). The one exception is a run's thumbs-down, which
 * is a 0 and nothing else: a 👎 means "not good" without grading how bad, and
 * a 👍 opens the 1-5 grading instead of storing a score of its own. 0 is legal
 * on the `run` surface only, so no average over 1-5 faces can include one.
 *
 * The output is a real foreign key per kind rather than a polymorphic id, so
 * a deleted quiz or run takes its ratings with it and a rating can never point
 * at a row in another table. Exactly one is set, and it must be the kind the
 * surface names. `output_id` is that one id, generated, so "one rating per
 * person per output" is a single unique index and a single upsert target.
 *
 * `model` and `prompt_version` are copied from the output at write time, never
 * taken from the caller: they are what the readout groups by, and a later
 * model change must not rewrite what an old rating was about.
 */

export const LLM_FEEDBACK_SURFACES = ["chat", "run", "quiz", "flashcards", "explain", "artifact"] as const;
export type LlmFeedbackSurface = (typeof LLM_FEEDBACK_SURFACES)[number];

export const llmFeedback = pgTable(
  "llm_feedback",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    surface: text("surface").$type<LlmFeedbackSurface>().notNull(),
    runEventId: uuid("run_event_id").references(() => runEvents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    quizId: uuid("quiz_id").references(() => quizzes.id, { onDelete: "cascade" }),
    flashcardDeckId: uuid("flashcard_deck_id").references(() => flashcardDecks.id, { onDelete: "cascade" }),
    explainTurnId: uuid("explain_turn_id").references(() => explainTurns.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "cascade" }),
    outputId: uuid("output_id")
      .notNull()
      .generatedAlwaysAs(sql`coalesce(run_event_id, run_id, quiz_id, flashcard_deck_id, explain_turn_id, artifact_id)`),
    /** 1 = 😞 … 5 = 😄; 0 = a run's thumbs-down. */
    score: smallint("score").notNull(),
    comment: text("comment"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("llm_feedback_one_per_user_output").on(t.workspaceId, t.userId, t.outputId),
    index("llm_feedback_workspace_surface_idx").on(t.workspaceId, t.surface, t.updatedAt),
    check("llm_feedback_score_check", sql`${t.score} between 1 and 5 or (${t.surface} = 'run' and ${t.score} = 0)`),
    check("llm_feedback_comment_check", sql`char_length(coalesce(${t.comment}, '')) <= 1000`),
    check(
      "llm_feedback_one_output",
      sql`num_nonnulls(${t.runEventId}, ${t.runId}, ${t.quizId}, ${t.flashcardDeckId}, ${t.explainTurnId}, ${t.artifactId}) = 1`,
    ),
    check(
      "llm_feedback_surface_output",
      sql`case ${t.surface}
        when 'chat' then ${t.runEventId} is not null
        when 'run' then ${t.runId} is not null
        when 'quiz' then ${t.quizId} is not null
        when 'flashcards' then ${t.flashcardDeckId} is not null
        when 'explain' then ${t.explainTurnId} is not null
        when 'artifact' then ${t.artifactId} is not null
        else false end`,
    ),
  ],
);
