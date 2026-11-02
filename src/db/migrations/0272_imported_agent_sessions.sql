CREATE TABLE "imported_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_session_id" text NOT NULL,
	"cwd" text NOT NULL,
	"started_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"summary" jsonb NOT NULL,
	"raw_blob_id" uuid,
	"decision_note" text,
	"decision_status" text DEFAULT 'inferred' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "imported_agent_sessions_source_check" CHECK (source in ('claude-code', 'codex')),
	CONSTRAINT "imported_agent_sessions_decision_status_check" CHECK (decision_status in ('recorded', 'inferred'))
);
--> statement-breakpoint
ALTER TABLE "imported_agent_sessions" ADD CONSTRAINT "imported_agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_agent_sessions" ADD CONSTRAINT "imported_agent_sessions_raw_blob_id_blob_objects_id_fk" FOREIGN KEY ("raw_blob_id") REFERENCES "public"."blob_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imported_agent_sessions_source_session_key" ON "imported_agent_sessions" USING btree ("workspace_id","source","external_session_id");--> statement-breakpoint
CREATE INDEX "imported_agent_sessions_activity_idx" ON "imported_agent_sessions" USING btree ("workspace_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "imported_agent_sessions_cwd_idx" ON "imported_agent_sessions" USING btree ("workspace_id","cwd");