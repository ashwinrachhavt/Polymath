CREATE TABLE "poll_fact_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"topic" text NOT NULL,
	"tags" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'job' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_fact_suggestions_text_unique" UNIQUE("text")
);
--> statement-breakpoint
CREATE INDEX "poll_fact_suggestions_status_idx" ON "poll_fact_suggestions" USING btree ("status","created_at");