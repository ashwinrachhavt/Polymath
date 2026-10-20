-- 0213 (ASH-187): the shared quota ledger for free-first provider usage. One
-- bucket per (workspace, provider, period) holds the period's allowance with
-- reserved/consumed counters; the reserve path is a single INSERT ... ON
-- CONFLICT ... WHERE consumed + reserved + new <= allowance, so concurrent
-- agents cannot over-draw a free balance. The ledger table is the append-only
-- evidence of every reserve, settle and release.
CREATE TABLE "provider_quota_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"period" text NOT NULL,
	"unit" text NOT NULL,
	"allowance" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_quota_buckets_allowance_check" CHECK ("allowance" > 0),
	CONSTRAINT "provider_quota_buckets_reserved_check" CHECK ("reserved" >= 0),
	CONSTRAINT "provider_quota_buckets_consumed_check" CHECK ("consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bucket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"units" integer NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_ledger_kind_check" CHECK ("kind" in ('reserve', 'settle', 'release')),
	CONSTRAINT "provider_usage_ledger_units_check" CHECK ("units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "provider_quota_buckets" ADD CONSTRAINT "provider_quota_buckets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_usage_ledger" ADD CONSTRAINT "provider_usage_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_usage_ledger" ADD CONSTRAINT "provider_usage_ledger_bucket_id_provider_quota_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."provider_quota_buckets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_quota_buckets_scope_key" ON "provider_quota_buckets" USING btree ("workspace_id","provider","period");
--> statement-breakpoint
CREATE INDEX "provider_usage_ledger_bucket_idx" ON "provider_usage_ledger" USING btree ("bucket_id");
