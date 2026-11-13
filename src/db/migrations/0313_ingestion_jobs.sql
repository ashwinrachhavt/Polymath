ALTER TYPE "public"."generation_job_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "capture_documents" (
	"workspace_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_documents_capture_id_document_id_pk" PRIMARY KEY("capture_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "video_transcripts" (
	"video_id" text PRIMARY KEY NOT NULL,
	"title" text,
	"language" text,
	"generated" boolean DEFAULT false NOT NULL,
	"cues" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "capture_documents" ADD CONSTRAINT "capture_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_documents" ADD CONSTRAINT "capture_documents_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_documents" ADD CONSTRAINT "capture_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_documents_document_idx" ON "capture_documents" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_owner_progress_idx" ON "generation_jobs" USING btree ("workspace_id","created_by","progress_at");