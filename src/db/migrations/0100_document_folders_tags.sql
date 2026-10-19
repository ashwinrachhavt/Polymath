-- Files surface: owner-made folders, one placement per document, and free tags.
-- Organisation only; documents, files and extractions are untouched. Additive.
CREATE TABLE "document_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "document_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_placements" ADD CONSTRAINT "document_placements_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_placements" ADD CONSTRAINT "document_placements_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_placements" ADD CONSTRAINT "document_placements_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."document_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_name_check" CHECK (length(btrim(name)) between 1 and 80);--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_tag_check" CHECK (tag = lower(btrim(tag)) and length(tag) between 1 and 40);--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_name_key" ON "document_folders" USING btree ("workspace_id",lower("name")) WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_placements_document_key" ON "document_placements" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_placements_folder_idx" ON "document_placements" USING btree ("workspace_id","folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_tags_document_tag_key" ON "document_tags" USING btree ("document_id","tag");--> statement-breakpoint
CREATE INDEX "document_tags_workspace_tag_idx" ON "document_tags" USING btree ("workspace_id","tag");
