CREATE TYPE "public"."contact_point_kind" AS ENUM('email', 'phone', 'url');--> statement-breakpoint
CREATE TYPE "public"."party_relationship_kind" AS ENUM('customer', 'prospect', 'vendor', 'partner');--> statement-breakpoint
CREATE TYPE "public"."party_relationship_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TABLE "account_person_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"method" text DEFAULT 'verified' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "contact_point_kind" NOT NULL,
	"value" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"label" text,
	"person_id" uuid,
	"organization_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "contact_points_one_side_check" CHECK ((person_id is null) <> (organization_id is null))
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text,
	"verified" boolean DEFAULT false NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "party_relationship_kind" DEFAULT 'prospect' NOT NULL,
	"status" "party_relationship_status" DEFAULT 'active' NOT NULL,
	"person_id" uuid,
	"organization_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "party_relationships_one_side_check" CHECK ((person_id is null) <> (organization_id is null))
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"honorific" text,
	"title" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
-- The two parent unique indexes must exist before the composite FKs below:
-- Postgres requires a unique index over exactly (workspace_id, id) on the
-- referenced side, and drizzle-kit emits indexes after constraints.
CREATE UNIQUE INDEX "people_workspace_id_key" ON "people" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_workspace_id_key" ON "organizations" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "account_person_links" ADD CONSTRAINT "account_person_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_person_links" ADD CONSTRAINT "account_person_links_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_person_links" ADD CONSTRAINT "account_person_links_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."organizations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_relationships" ADD CONSTRAINT "party_relationships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_relationships" ADD CONSTRAINT "party_relationships_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_relationships" ADD CONSTRAINT "party_relationships_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."organizations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_person_links_key" ON "account_person_links" USING btree ("workspace_id","account_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_person_links_account_key" ON "account_person_links" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_points_primary_key" ON "contact_points" USING btree ("person_id","organization_id","kind") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "contact_points_value_idx" ON "contact_points" USING btree ("kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_provider_key" ON "external_identities" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_workspace_provider_key" ON "external_identities" USING btree ("workspace_id","provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "external_identities_email_idx" ON "external_identities" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "organizations_workspace_active_idx" ON "organizations" USING btree ("workspace_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_workspace_domain_key" ON "organizations" USING btree ("workspace_id","domain") WHERE domain is not null;--> statement-breakpoint
CREATE INDEX "party_relationships_person_idx" ON "party_relationships" USING btree ("person_id","kind");--> statement-breakpoint
CREATE INDEX "party_relationships_organization_idx" ON "party_relationships" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "people_workspace_active_idx" ON "people" USING btree ("workspace_id","display_name") WHERE archived_at is null;