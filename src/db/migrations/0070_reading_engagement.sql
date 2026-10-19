-- D18 (ASH-144): reading history and engagement on the canonical document
-- store. Append-only events are the truth; the per-(document, user) state row
-- is the folded "where you are", updated in the same transaction so a crash
-- can never leave one without the other. Additive - documents, files and
-- extractions are untouched.
CREATE TABLE "document_reading_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"progress" real,
	"page" integer,
	"active_seconds" integer,
	"client_event_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_reading_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"first_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"total_active_seconds" integer DEFAULT 0 NOT NULL,
	"furthest_progress" real DEFAULT 0 NOT NULL,
	"last_page" integer,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
ALTER TABLE "document_reading_events" ADD CONSTRAINT "document_reading_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reading_events" ADD CONSTRAINT "document_reading_events_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reading_events" ADD CONSTRAINT "document_reading_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reading_state" ADD CONSTRAINT "document_reading_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reading_state" ADD CONSTRAINT "document_reading_state_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reading_state" ADD CONSTRAINT "document_reading_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reading_events" ADD CONSTRAINT "document_reading_events_kind_check" CHECK (kind in ('opened', 'progress', 'closed'));--> statement-breakpoint
ALTER TABLE "document_reading_events" ADD CONSTRAINT "document_reading_events_progress_range_check" CHECK (progress is null or (progress >= 0 and progress <= 1));--> statement-breakpoint
ALTER TABLE "document_reading_events" ADD CONSTRAINT "document_reading_events_active_seconds_range_check" CHECK (active_seconds is null or (active_seconds >= 0 and active_seconds <= 14400));--> statement-breakpoint
ALTER TABLE "document_reading_state" ADD CONSTRAINT "document_reading_state_furthest_progress_range_check" CHECK (furthest_progress >= 0 and furthest_progress <= 1);--> statement-breakpoint
CREATE UNIQUE INDEX "document_reading_events_client_event_key" ON "document_reading_events" USING btree ("workspace_id","document_id","user_id","client_event_id") WHERE client_event_id is not null;--> statement-breakpoint
CREATE INDEX "document_reading_events_document_idx" ON "document_reading_events" USING btree ("workspace_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_reading_events_user_history_idx" ON "document_reading_events" USING btree ("workspace_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_reading_state_document_user_key" ON "document_reading_state" USING btree ("workspace_id","document_id","user_id");--> statement-breakpoint
CREATE INDEX "document_reading_state_user_recent_idx" ON "document_reading_state" USING btree ("workspace_id","user_id","last_opened_at");
