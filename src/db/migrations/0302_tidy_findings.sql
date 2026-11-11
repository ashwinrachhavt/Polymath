CREATE TABLE "tidy_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"other_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tidy_findings_kind_check" CHECK (kind in ('disagreement', 'duplicate', 'source_changed', 'unlinked', 'broken_link')),
	CONSTRAINT "tidy_findings_status_check" CHECK (status in ('open', 'resolved', 'dismissed', 'cleared')),
	CONSTRAINT "tidy_findings_resolution_check" CHECK ((status = 'resolved') = (resolution is not null) and (resolution is null or resolution in ('first_holds', 'second_holds', 'both_hold'))),
	CONSTRAINT "tidy_findings_decided_check" CHECK ((status in ('resolved', 'dismissed')) = (resolved_at is not null)),
	CONSTRAINT "tidy_findings_pair_check" CHECK ((kind in ('disagreement', 'duplicate')) = (other_id is not null))
);
--> statement-breakpoint
ALTER TABLE "tidy_findings" ADD CONSTRAINT "tidy_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tidy_findings" ADD CONSTRAINT "tidy_findings_subject_id_artifacts_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tidy_findings" ADD CONSTRAINT "tidy_findings_other_id_artifacts_id_fk" FOREIGN KEY ("other_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tidy_findings_dedupe_key" ON "tidy_findings" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "tidy_findings_status_idx" ON "tidy_findings" USING btree ("workspace_id","status","kind","created_at");--> statement-breakpoint
CREATE INDEX "tidy_findings_subject_idx" ON "tidy_findings" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "tidy_findings_other_idx" ON "tidy_findings" USING btree ("other_id");