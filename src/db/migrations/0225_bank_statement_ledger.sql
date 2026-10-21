-- 0225: bank statement -> ledger. Two tables and one column.
--
-- The statement ledger is a read of a document, not a second document store.
-- statement_imports is keyed by the extraction it was parsed from, so reading
-- the same file again with a better mapper adds an import instead of editing
-- one the owner may already have exported. statement_transactions holds the
-- rows, signed so the CSV's single amount column can be summed.
--
-- document_extractions.tables carries the provider's table cell grid. Docling
-- already returns it; storing it means a statement can be re-parsed against a
-- better mapper without paying for the conversion twice.
ALTER TABLE "document_extractions" ADD COLUMN IF NOT EXISTS "tables" jsonb;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."statement_import_status" AS ENUM ('parsed', 'needs_review', 'unsupported');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statement_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "extraction_id" uuid NOT NULL,
  "status" "statement_import_status" NOT NULL,
  "account_label" text NOT NULL,
  "period_start" date,
  "period_end" date,
  "opening_balance" numeric(18, 2),
  "closing_balance" numeric(18, 2),
  "transaction_count" integer DEFAULT 0 NOT NULL,
  "reconciled" boolean DEFAULT false NOT NULL,
  "reconciliation" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "mapping" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statement_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "import_id" uuid NOT NULL,
  "account_label" text NOT NULL,
  "occurred_on" date NOT NULL,
  "description" text NOT NULL,
  "raw_description" text NOT NULL,
  "amount" numeric(18, 2) NOT NULL,
  "balance_after" numeric(18, 2),
  "position" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "statement_transactions_amount_nonzero" CHECK (amount <> 0)
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_document_id_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_extraction_id_document_extractions_id_fk"
    FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "statement_transactions" ADD CONSTRAINT "statement_transactions_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "statement_transactions" ADD CONSTRAINT "statement_transactions_import_id_statement_imports_id_fk"
    FOREIGN KEY ("import_id") REFERENCES "public"."statement_imports"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statement_imports_extraction_key" ON "statement_imports" USING btree ("extraction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_imports_document_idx" ON "statement_imports" USING btree ("workspace_id","document_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statement_transactions_position_key" ON "statement_transactions" USING btree ("import_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_transactions_ledger_idx" ON "statement_transactions" USING btree ("workspace_id","account_label","occurred_on");
