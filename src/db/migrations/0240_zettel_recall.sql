-- 0240: zettel cards and recall (Product Spec, "Zettel Cards and recall").
--
-- Cards are generated from a note or a claim, reviewed before they
-- circulate, and always cite their source: cards.artifact_id is required and
-- cascades with the note/zettel, so an unsourced card cannot survive its
-- source. Review is retrieval, not recognition - prompt and answer, no
-- options. This is new storage, not the Learning tables #222's 0235 drops:
-- the spec's model has no decks, plans or quiz kinds, and the two designs
-- stay independent so 0235 remains its own owner decision.
--
-- due_at is the queue key and is null outside the rotation (proposed,
-- suspended, retired); the partial index is exactly the review queue's
-- filter. card_reviews is append-only attempt history; the card row is the
-- projection.
CREATE TYPE "card_state" AS ENUM ('proposed', 'scheduled', 'suspended', 'retired');--> statement-breakpoint
CREATE TYPE "card_review_outcome" AS ENUM ('correct', 'wrong');--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"answer" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"claim_id" uuid,
	"state" "card_state" DEFAULT 'proposed' NOT NULL,
	"last_outcome" "card_review_outcome",
	"due_at" timestamp with time zone,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"ease_factor" real DEFAULT 2.5 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"outcome" "card_review_outcome" NOT NULL,
	"response_text" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_due_idx" ON "cards" ("workspace_id","due_at") WHERE "state" = 'scheduled';--> statement-breakpoint
CREATE INDEX "cards_workspace_state_idx" ON "cards" ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "cards_artifact_idx" ON "cards" ("artifact_id");--> statement-breakpoint
CREATE INDEX "card_reviews_card_idx" ON "card_reviews" ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "card_reviews_workspace_idx" ON "card_reviews" ("workspace_id","created_at");
