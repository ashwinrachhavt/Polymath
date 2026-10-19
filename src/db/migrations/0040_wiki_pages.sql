CREATE TYPE "public"."wiki_page_role" AS ENUM('index', 'topic', 'article', 'log');--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "wiki_page_role" NOT NULL,
	"topic_slug" text,
	"document_id" uuid,
	"artifact_id" uuid NOT NULL,
	"topic_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"pinned_content_hash" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_singleton_key" ON "wiki_pages" USING btree ("workspace_id","role") WHERE role in ('index', 'log');--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_topic_key" ON "wiki_pages" USING btree ("workspace_id","topic_slug") WHERE role = 'topic';--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_article_key" ON "wiki_pages" USING btree ("workspace_id","document_id") WHERE role = 'article';--> statement-breakpoint
CREATE INDEX "wiki_pages_workspace_role_idx" ON "wiki_pages" USING btree ("workspace_id","role");