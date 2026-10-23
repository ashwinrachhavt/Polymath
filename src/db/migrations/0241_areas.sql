-- 0241: areas and progress (Product Spec, "Areas and progress").
--
-- Areas are declared by the person, never inferred: a name plus the note
-- tags it covers. Effort (notes, manual links, recall activity) and
-- knowledge confidence (recall accuracy, accepted claims) are computed from
-- live content at read time - this table deliberately stores no counters,
-- so there is no projection to drift and no single score: the spec demands
-- effort and confidence side by side, never averaged.
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "areas_workspace_name_key" ON "areas" ("workspace_id", (lower("name"))) WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "areas_workspace_idx" ON "areas" ("workspace_id","archived_at");
