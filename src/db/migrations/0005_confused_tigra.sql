CREATE TYPE "public"."assertion_status" AS ENUM('active', 'superseded', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."assertion_subject_type" AS ENUM('contact', 'company', 'project', 'document');--> statement-breakpoint
CREATE TYPE "public"."document_party_kind" AS ENUM('contact', 'company');--> statement-breakpoint
CREATE TYPE "public"."document_party_role" AS ENUM('subject', 'sender', 'recipient', 'issuer', 'signatory', 'representative', 'mentioned');--> statement-breakpoint
CREATE TYPE "public"."field_kind" AS ENUM('date', 'money', 'text', 'identifier', 'person', 'organization', 'address', 'other');--> statement-breakpoint
CREATE TYPE "public"."field_proposal_status" AS ENUM('proposed', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."obligation_status" AS ENUM('proposed', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."party_resolution_status" AS ENUM('unresolved', 'matched', 'created', 'rejected');--> statement-breakpoint
CREATE TABLE "document_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"field_proposal_id" uuid,
	"kind" text NOT NULL,
	"note" text,
	"due_from_document" timestamp with time zone,
	"dedupe_key" text NOT NULL,
	"task_id" uuid,
	"status" "obligation_status" DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"superseded_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"party_role" "document_party_role" NOT NULL,
	"party_kind" "document_party_kind" NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"display_name" text NOT NULL,
	"resolution_status" "party_resolution_status" DEFAULT 'unresolved' NOT NULL,
	"evidence_extraction_id" uuid,
	"evidence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "document_parties_one_target_check" CHECK (not (contact_id is not null and company_id is not null))
);
--> statement-breakpoint
CREATE TABLE "field_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"field_kind" "field_kind" NOT NULL,
	"field_name" text NOT NULL,
	"raw_value" text,
	"normalized_value" jsonb,
	"normalization_note" text,
	"confidence" text,
	"dedupe_key" text NOT NULL,
	"status" "field_proposal_status" DEFAULT 'proposed' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"accepted_value" jsonb,
	"evidence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewed_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" "assertion_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"attribute" text NOT NULL,
	"value" jsonb NOT NULL,
	"document_id" uuid,
	"extraction_id" uuid,
	"field_proposal_id" uuid,
	"evidence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_attribution" text NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"supersedes_assertion_id" uuid,
	"status" "assertion_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_obligations" ADD CONSTRAINT "document_obligations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_obligations" ADD CONSTRAINT "document_obligations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_obligations" ADD CONSTRAINT "document_obligations_field_proposal_id_field_proposals_id_fk" FOREIGN KEY ("field_proposal_id") REFERENCES "public"."field_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_evidence_extraction_id_document_extractions_id_fk" FOREIGN KEY ("evidence_extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_proposals" ADD CONSTRAINT "field_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_proposals" ADD CONSTRAINT "field_proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_proposals" ADD CONSTRAINT "field_proposals_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_assertions" ADD CONSTRAINT "reviewed_assertions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_assertions" ADD CONSTRAINT "reviewed_assertions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_assertions" ADD CONSTRAINT "reviewed_assertions_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_assertions" ADD CONSTRAINT "reviewed_assertions_field_proposal_id_field_proposals_id_fk" FOREIGN KEY ("field_proposal_id") REFERENCES "public"."field_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_assertions" ADD CONSTRAINT "reviewed_assertions_supersedes_assertion_id_reviewed_assertions_id_fk" FOREIGN KEY ("supersedes_assertion_id") REFERENCES "public"."reviewed_assertions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_obligations_dedupe_key" ON "document_obligations" USING btree ("document_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "document_obligations_workspace_status_idx" ON "document_obligations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "document_parties_contact_key" ON "document_parties" USING btree ("document_id","party_role","contact_id") WHERE contact_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_parties_company_key" ON "document_parties" USING btree ("document_id","party_role","company_id") WHERE company_id is not null;--> statement-breakpoint
CREATE INDEX "document_parties_document_idx" ON "document_parties" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_proposals_dedupe_key" ON "field_proposals" USING btree ("document_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "field_proposals_workspace_status_idx" ON "field_proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "reviewed_assertions_subject_idx" ON "reviewed_assertions" USING btree ("workspace_id","subject_type","subject_id","attribute","status");
CREATE INDEX "reviewed_assertions_workspace_document_active_idx" ON "reviewed_assertions" USING btree ("workspace_id","document_id") WHERE "status" = 'active';
