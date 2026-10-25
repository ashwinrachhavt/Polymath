-- 0250: ASH-272 knowledge taxonomy catalog, ported from the alfred donor's
-- master ontology (frozen, read-only). Three levels (domain -> subdomain ->
-- microtopic); the Jev capture classifier may only write labels that resolve
-- here, and the composite self-FK keeps a child from ever pointing at
-- another workspace's parent (tenant integrity enforced by the database).
--
-- Hand-written, like 0249: drizzle-kit generate cannot run against the
-- snapshot chain the 0248/0249 repairs left behind (meta/ holds 15 snapshots
-- for 76 journal entries; 0040_snapshot.json points at 0031's parent, which
-- drizzle rejects as a collision). Column set mirrors taxonomyNodes in
-- src/domains/knowledge/schema.ts exactly; check-migrations guards the
-- journal entry.
CREATE TABLE "taxonomy_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"level" smallint NOT NULL,
	"parent_slug" text,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "taxonomy_nodes_workspace_slug_key" UNIQUE("workspace_id", "slug"),
	CONSTRAINT "taxonomy_nodes_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 128),
	CONSTRAINT "taxonomy_nodes_level_range" CHECK (level between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_parent_fk" FOREIGN KEY ("workspace_id", "parent_slug") REFERENCES "public"."taxonomy_nodes"("workspace_id", "slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "taxonomy_nodes_parent_idx" ON "taxonomy_nodes" USING btree ("workspace_id", "parent_slug");--> statement-breakpoint
CREATE INDEX "taxonomy_nodes_level_idx" ON "taxonomy_nodes" USING btree ("workspace_id", "level");--> statement-breakpoint
CREATE INDEX "taxonomy_nodes_tree_idx" ON "taxonomy_nodes" USING btree ("workspace_id", "parent_slug", "sort_order");
