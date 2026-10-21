-- 0227: remembered category corrections for statement transactions.
--
-- One row per (workspace, merchant key). The key is computed by the classifier
-- from the description with rails, dates and reference numbers stripped, so a
-- correction made on one statement applies to the same merchant on the next.
-- Category is text checked at the application edge, not an enum, so growing the
-- taxonomy never needs a migration.
CREATE TABLE IF NOT EXISTS "transaction_category_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "merchant_key" text NOT NULL,
  "category" text NOT NULL,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "transaction_category_rules_key_nonempty" CHECK (length(merchant_key) > 0)
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "transaction_category_rules" ADD CONSTRAINT "transaction_category_rules_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_category_rules_key" ON "transaction_category_rules" USING btree ("workspace_id","merchant_key");
