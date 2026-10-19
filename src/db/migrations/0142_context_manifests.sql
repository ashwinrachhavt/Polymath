-- ASH-118 (RT04): source-version-pinned context manifests. Additive only.
CREATE TYPE "public"."manifest_item_kind" AS ENUM('record','artifact_version','source_span','memory_revision','message');--> statement-breakpoint
CREATE TYPE "public"."manifest_item_staleness" AS ENUM('current','superseded','stale','conflicting');--> statement-breakpoint
CREATE TABLE "context_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"profile_revision_id" uuid,
	"purpose" text NOT NULL,
	"selection_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retrieval_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"gap_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_manifests_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "context_manifests_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "context_manifests_workspace_id_key" ON "context_manifests" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "context_manifests_workspace_idx" ON "context_manifests" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "context_manifests_run_idx" ON "context_manifests" USING btree ("run_id");--> statement-breakpoint
CREATE TABLE "context_manifest_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "manifest_item_kind" NOT NULL,
	"ref_id" uuid NOT NULL,
	"ref_parent_id" uuid,
	"ref_version" integer,
	"content_hash" text,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"selection_reason" text,
	"staleness" "manifest_item_staleness" DEFAULT 'current' NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_manifest_items_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."context_manifests"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "context_manifest_items_tenant_manifest_fk" FOREIGN KEY ("workspace_id","manifest_id") REFERENCES "public"."context_manifests"("workspace_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "context_manifest_items_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "context_manifest_items_ordinal_key" ON "context_manifest_items" USING btree ("manifest_id","ordinal");--> statement-breakpoint
CREATE INDEX "context_manifest_items_ref_idx" ON "context_manifest_items" USING btree ("workspace_id","kind","ref_id");
