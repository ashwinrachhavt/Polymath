-- Export packets (ASH-130 full packets): an assembled, immutable zip of the
-- exact pinned versions of one manifest, stored as a blob. Additive only.
CREATE TABLE "document_export_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"manifest_version" integer NOT NULL,
	"blob_id" uuid NOT NULL,
	"item_count" integer NOT NULL,
	"missing_count" integer NOT NULL DEFAULT 0,
	"drifted_count" integer NOT NULL DEFAULT 0,
	"size_bytes" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_export_packets_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "document_export_packets_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."document_export_manifests"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "document_export_packets_blob_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blob_objects"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "document_export_packets_manifest_idx" ON "document_export_packets" USING btree ("manifest_id","created_at");
--> statement-breakpoint
CREATE INDEX "document_export_packets_workspace_idx" ON "document_export_packets" USING btree ("workspace_id","created_at");
