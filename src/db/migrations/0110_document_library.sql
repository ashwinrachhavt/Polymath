-- Box-feel library backend (ASH-108, ASH-127, ASH-130): the folder tree a
-- file manager files documents into, the filing history the activity feed
-- reads, export manifests that pin exact extraction versions, and the
-- indexes that keep library list + search fast at scale. Additive only.
CREATE TABLE "document_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_folder_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"from_folder_id" uuid,
	"to_folder_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_export_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"contact_id" uuid,
	"company_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_export_manifest_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_id" uuid,
	"extraction_content_hash" text,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."document_folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_events" ADD CONSTRAINT "document_folder_events_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_events" ADD CONSTRAINT "document_folder_events_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_events" ADD CONSTRAINT "document_folder_events_from_folder_id_fk" FOREIGN KEY ("from_folder_id") REFERENCES "public"."document_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folder_events" ADD CONSTRAINT "document_folder_events_to_folder_id_fk" FOREIGN KEY ("to_folder_id") REFERENCES "public"."document_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifests" ADD CONSTRAINT "document_export_manifests_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifests" ADD CONSTRAINT "document_export_manifests_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifests" ADD CONSTRAINT "document_export_manifests_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifest_items" ADD CONSTRAINT "document_export_manifest_items_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifest_items" ADD CONSTRAINT "document_export_manifest_items_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."document_export_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifest_items" ADD CONSTRAINT "document_export_manifest_items_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_export_manifest_items" ADD CONSTRAINT "document_export_manifest_items_extraction_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."document_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_name_key" ON "document_folders" USING btree ("workspace_id",coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),lower(name)) WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "document_folders_parent_idx" ON "document_folders" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "document_folder_events_document_idx" ON "document_folder_events" USING btree ("workspace_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_export_manifests_workspace_idx" ON "document_export_manifests" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_export_manifest_items_document_key" ON "document_export_manifest_items" USING btree ("manifest_id","document_id");--> statement-breakpoint
CREATE INDEX "document_export_manifest_items_manifest_idx" ON "document_export_manifest_items" USING btree ("workspace_id","manifest_id","position");--> statement-breakpoint
CREATE INDEX "documents_folder_idx" ON "documents" USING btree ("workspace_id","folder_id");--> statement-breakpoint
-- Fast search (ASH-130): full-text over extraction text and trigram match
-- over titles and original filenames, so the library's find stays interactive
-- as the archive grows. pg_trgm ships with Postgres contrib and Neon.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "document_extractions_text_fts_idx" ON "document_extractions" USING gin (to_tsvector('english', coalesce("text", '')));--> statement-breakpoint
CREATE INDEX "documents_title_trgm_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "files_filename_trgm_idx" ON "files" USING gin ("filename" gin_trgm_ops);--> statement-breakpoint
CREATE TABLE "document_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_tag_check" CHECK (tag = lower(btrim(tag)) and length(tag) between 1 and 40);--> statement-breakpoint
CREATE UNIQUE INDEX "document_tags_document_tag_key" ON "document_tags" USING btree ("document_id","tag");--> statement-breakpoint
CREATE INDEX "document_tags_workspace_tag_idx" ON "document_tags" USING btree ("workspace_id","tag");
