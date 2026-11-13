CREATE TABLE "llm_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"run_event_id" uuid,
	"run_id" uuid,
	"quiz_id" uuid,
	"flashcard_deck_id" uuid,
	"explain_turn_id" uuid,
	"artifact_id" uuid,
	"output_id" uuid GENERATED ALWAYS AS (coalesce(run_event_id, run_id, quiz_id, flashcard_deck_id, explain_turn_id, artifact_id)) STORED NOT NULL,
	"score" smallint NOT NULL,
	"comment" text,
	"model" text,
	"prompt_version" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "llm_feedback_score_check" CHECK ("llm_feedback"."score" between 1 and 5 or ("llm_feedback"."surface" = 'run' and "llm_feedback"."score" = 0)),
	CONSTRAINT "llm_feedback_comment_check" CHECK (char_length(coalesce("llm_feedback"."comment", '')) <= 1000),
	CONSTRAINT "llm_feedback_one_output" CHECK (num_nonnulls("llm_feedback"."run_event_id", "llm_feedback"."run_id", "llm_feedback"."quiz_id", "llm_feedback"."flashcard_deck_id", "llm_feedback"."explain_turn_id", "llm_feedback"."artifact_id") = 1),
	CONSTRAINT "llm_feedback_surface_output" CHECK (case "llm_feedback"."surface"
        when 'chat' then "llm_feedback"."run_event_id" is not null
        when 'run' then "llm_feedback"."run_id" is not null
        when 'quiz' then "llm_feedback"."quiz_id" is not null
        when 'flashcards' then "llm_feedback"."flashcard_deck_id" is not null
        when 'explain' then "llm_feedback"."explain_turn_id" is not null
        when 'artifact' then "llm_feedback"."artifact_id" is not null
        else false end)
);--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_run_event_id_run_events_id_fk" FOREIGN KEY ("run_event_id") REFERENCES "public"."run_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_flashcard_deck_id_flashcard_decks_id_fk" FOREIGN KEY ("flashcard_deck_id") REFERENCES "public"."flashcard_decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_explain_turn_id_explain_turns_id_fk" FOREIGN KEY ("explain_turn_id") REFERENCES "public"."explain_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_feedback" ADD CONSTRAINT "llm_feedback_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_feedback_one_per_user_output" ON "llm_feedback" USING btree ("workspace_id","user_id","output_id");--> statement-breakpoint
CREATE INDEX "llm_feedback_workspace_surface_idx" ON "llm_feedback" USING btree ("workspace_id","surface","updated_at");--> statement-breakpoint
-- Backfill: the three old rating stores become llm_feedback rows.
-- Scores: a thumbs-up or "helpful" had no grade, so it carries across as 4
-- (the 🙂 face); a thumbs-down on a message, quiz, deck or artifact as 2 (🙁).
-- A run's thumbs-down becomes 0, the run-only "not good, ungraded" score. A
-- rating whose author is unknown (a run with no recorded creator) cannot be
-- attributed to a person and is not carried.
INSERT INTO "llm_feedback" ("workspace_id", "user_id", "surface", "run_event_id", "score", "model", "prompt_version", "created_by", "updated_by", "created_at", "updated_at")
SELECT e."workspace_id", r."created_by", 'chat', e."id",
       CASE e."feedback" WHEN 'up' THEN 4 ELSE 2 END,
       r."model", r."profile_revision_id"::text, r."created_by", r."created_by", e."created_at", now()
FROM "run_events" e
JOIN "agent_runs" r ON r."id" = e."run_id" AND r."workspace_id" = e."workspace_id"
JOIN "users" u ON u."id" = r."created_by"
WHERE e."feedback" IN ('up', 'down')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "llm_feedback" ("workspace_id", "user_id", "surface", "quiz_id", "flashcard_deck_id", "artifact_id", "score", "model", "prompt_version", "created_by", "updated_by", "created_at", "updated_at")
SELECT f."workspace_id", f."user_id",
       CASE WHEN f."quiz_id" IS NOT NULL THEN 'quiz' WHEN f."flashcard_deck_id" IS NOT NULL THEN 'flashcards' ELSE 'artifact' END,
       f."quiz_id", f."flashcard_deck_id", f."artifact_id",
       CASE f."rating" WHEN 'helpful' THEN 4 ELSE 2 END,
       coalesce(q."model", d."model"), coalesce(q."prompt_version", d."prompt_version"),
       f."created_by", f."updated_by", f."created_at", f."updated_at"
FROM "artifact_feedback" f
LEFT JOIN "quizzes" q ON q."id" = f."quiz_id"
LEFT JOIN "flashcard_decks" d ON d."id" = f."flashcard_deck_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The run-level verdict: its reason chips and line become the comment. A cleared
-- verdict (null) had no rating and is not carried.
INSERT INTO "llm_feedback" ("workspace_id", "user_id", "surface", "run_id", "score", "comment", "model", "prompt_version", "created_by", "updated_by", "created_at", "updated_at")
SELECT rr."workspace_id", rr."created_by", 'run', rr."run_id",
       CASE rr."verdict" WHEN 'up' THEN 4 ELSE 0 END,
       nullif(left(concat_ws(': ', nullif(array_to_string(rr."reasons", ', '), ''), nullif(btrim(rr."note"), '')), 1000), ''),
       rr."model", rr."profile_revision_id"::text, rr."created_by", rr."updated_by", rr."created_at", rr."updated_at"
FROM "run_reviews" rr
JOIN "users" u ON u."id" = rr."created_by"
WHERE rr."kind" = 'user_feedback' AND rr."verdict" IN ('up', 'down')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "run_reviews" WHERE "kind" = 'user_feedback';--> statement-breakpoint
ALTER TABLE "run_reviews" DROP CONSTRAINT "run_reviews_verdict_check";--> statement-breakpoint
ALTER TABLE "run_reviews" DROP CONSTRAINT "run_reviews_reasons_check";--> statement-breakpoint
ALTER TABLE "run_reviews" DROP CONSTRAINT "run_reviews_field_caps";--> statement-breakpoint
-- The partial indexes compare kind to a literal, so they cannot survive the
-- column changing type; the feedback one has no rows left to index.
DROP INDEX "run_reviews_one_feedback_per_run";--> statement-breakpoint
DROP INDEX "run_reviews_one_critique_per_run";--> statement-breakpoint
ALTER TABLE "run_reviews" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."run_review_kind";--> statement-breakpoint
CREATE TYPE "public"."run_review_kind" AS ENUM('critique');--> statement-breakpoint
ALTER TABLE "run_reviews" ALTER COLUMN "kind" SET DATA TYPE "public"."run_review_kind" USING "kind"::"public"."run_review_kind";--> statement-breakpoint
CREATE UNIQUE INDEX "run_reviews_one_critique_per_run" ON "run_reviews" USING btree ("workspace_id","run_id") WHERE kind = 'critique';--> statement-breakpoint
ALTER TABLE "run_reviews" DROP COLUMN "verdict";--> statement-breakpoint
ALTER TABLE "run_reviews" DROP COLUMN "reasons";--> statement-breakpoint
ALTER TABLE "run_reviews" DROP COLUMN "note";--> statement-breakpoint
ALTER TABLE "run_reviews" ADD CONSTRAINT "run_reviews_field_caps" CHECK (char_length(coalesce(got_wrong, '')) <= 600 and char_length(coalesce(was_thin, '')) <= 600 and char_length(coalesce(would_do_differently, '')) <= 600);--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "explain_sessions" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "run_events" DROP COLUMN "feedback";--> statement-breakpoint
DROP TABLE "artifact_feedback";
