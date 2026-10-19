-- ASH-121 AC03: custom role definitions with immutable, catalog-versioned
-- revisions. Forward-only and additive. Nothing enforces these roles yet -
-- the fixed four roles still rule - so no existing behavior changes.
CREATE TABLE "role_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "role_definitions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "role_definitions_workspace_id_id_key" UNIQUE ("workspace_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "role_definitions_workspace_key_key" ON "role_definitions" USING btree ("workspace_id","key");
--> statement-breakpoint
CREATE TABLE "role_definition_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role_definition_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"catalog_version" integer NOT NULL,
	"capabilities" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_definition_revisions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "role_definition_revisions_definition_fk" FOREIGN KEY ("workspace_id", "role_definition_id") REFERENCES "public"."role_definitions"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "role_definition_revisions_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
	CONSTRAINT "role_definition_revisions_definition_revision_key" UNIQUE ("role_definition_id", "revision")
);
--> statement-breakpoint
-- A role edit appends a revision; an existing revision never changes.
CREATE TRIGGER "role_definition_revisions_immutable" BEFORE UPDATE ON "role_definition_revisions" FOR EACH ROW EXECUTE FUNCTION "axiom_reject_update"();
