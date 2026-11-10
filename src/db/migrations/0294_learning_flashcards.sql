CREATE TABLE "flashcard_decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"notebook_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"generation_key" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flashcard_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flashcard_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"ease_hundredths" integer DEFAULT 250 NOT NULL,
	"repetitions" integer DEFAULT 0 NOT NULL,
	"last_rating" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "flashcard_reviews_schedule_check" CHECK (interval_days >= 0 and ease_hundredths between 130 and 350 and repetitions >= 0),
	CONSTRAINT "flashcard_reviews_rating_check" CHECK (last_rating is null or last_rating in ('again', 'hard', 'good', 'easy'))
);
--> statement-breakpoint
CREATE TABLE "flashcards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deck_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"prompt" text NOT NULL,
	"answer" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flashcard_decks" ADD CONSTRAINT "flashcard_decks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcard_decks" ADD CONSTRAINT "flashcard_decks_notebook_id_notebooks_id_fk" FOREIGN KEY ("notebook_id") REFERENCES "public"."notebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcard_reviews" ADD CONSTRAINT "flashcard_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcard_reviews" ADD CONSTRAINT "flashcard_reviews_flashcard_id_flashcards_id_fk" FOREIGN KEY ("flashcard_id") REFERENCES "public"."flashcards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcard_reviews" ADD CONSTRAINT "flashcard_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_deck_id_flashcard_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."flashcard_decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flashcard_decks_generation_key" ON "flashcard_decks" USING btree ("workspace_id","generation_key");--> statement-breakpoint
CREATE INDEX "flashcard_decks_workspace_created_idx" ON "flashcard_decks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flashcard_reviews_user_card_key" ON "flashcard_reviews" USING btree ("workspace_id","flashcard_id","user_id");--> statement-breakpoint
CREATE INDEX "flashcard_reviews_due_idx" ON "flashcard_reviews" USING btree ("workspace_id","user_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flashcards_deck_ordinal_key" ON "flashcards" USING btree ("deck_id","ordinal");--> statement-breakpoint
CREATE INDEX "flashcards_workspace_deck_idx" ON "flashcards" USING btree ("workspace_id","deck_id");