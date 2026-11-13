CREATE TABLE "bug_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"signal" jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issue_number" integer,
	"filed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "bug_signals_fingerprint_unique" UNIQUE("fingerprint"),
	CONSTRAINT "bug_signals_filed_together" CHECK ((issue_number is null) = (filed_at is null))
);
--> statement-breakpoint
CREATE INDEX "bug_signals_unfiled_idx" ON "bug_signals" USING btree ("first_seen_at") WHERE issue_number is null;--> statement-breakpoint
CREATE INDEX "bug_signals_filed_at_idx" ON "bug_signals" USING btree ("filed_at");