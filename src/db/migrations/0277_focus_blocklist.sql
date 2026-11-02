CREATE TYPE "public"."focus_blocklist_kind" AS ENUM('block', 'allow');--> statement-breakpoint
CREATE TABLE "focus_blocklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"kind" "focus_blocklist_kind" DEFAULT 'block' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "focus_blocklist" ADD CONSTRAINT "focus_blocklist_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "focus_blocklist_pattern_key" ON "focus_blocklist" USING btree ("workspace_id","pattern") WHERE "focus_blocklist"."archived_at" is null;