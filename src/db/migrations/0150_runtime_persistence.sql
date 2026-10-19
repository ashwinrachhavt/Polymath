-- ASH-117 / A24: immutable profile revisions and durable runtime bindings.
-- Forward-only and additive. Existing runs keep a NULL profile_revision_id
-- (they predate revisions); nothing is backfilled or dispatched.

-- Tenant-aware reference targets: a child row can only point at a parent in
-- the same workspace when the foreign key includes workspace_id.
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_workspace_id_id_key" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_id_key" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_id_key" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_id_key" UNIQUE ("workspace_id", "id");
--> statement-breakpoint
CREATE FUNCTION "axiom_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TABLE "agent_profile_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_revisions_revision_positive" CHECK ("revision" >= 1),
	CONSTRAINT "agent_profile_revisions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_profile_revisions_profile_fk" FOREIGN KEY ("workspace_id", "agent_profile_id") REFERENCES "public"."agent_profiles"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_profile_revisions_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
	CONSTRAINT "agent_profile_revisions_profile_revision_key" UNIQUE ("agent_profile_id", "revision"),
	CONSTRAINT "agent_profile_revisions_profile_hash_key" UNIQUE ("agent_profile_id", "content_hash")
);
--> statement-breakpoint
CREATE TRIGGER "agent_profile_revisions_immutable" BEFORE UPDATE ON "agent_profile_revisions" FOR EACH ROW EXECUTE FUNCTION "axiom_reject_update"();
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "profile_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_profile_revision_fk" FOREIGN KEY ("workspace_id", "profile_revision_id") REFERENCES "public"."agent_profile_revisions"("workspace_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "agent_runs_freeze_admission"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."profile_revision_id" IS NOT NULL AND NEW."profile_revision_id" IS DISTINCT FROM OLD."profile_revision_id" THEN
		RAISE EXCEPTION 'agent_runs.profile_revision_id is fixed at admission' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."policy_snapshot" IS DISTINCT FROM OLD."policy_snapshot" OR NEW."agent_profile_id" IS DISTINCT FROM OLD."agent_profile_id" THEN
		RAISE EXCEPTION 'agent_runs admission inputs are immutable' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_runs_freeze_admission" BEFORE UPDATE ON "agent_runs" FOR EACH ROW EXECUTE FUNCTION "agent_runs_freeze_admission"();
--> statement-breakpoint
-- Same-workspace integrity for the existing references. NOT VALID enforces
-- every new or changed row without failing on legacy rows; a later operational
-- step can VALIDATE CONSTRAINT once production data is confirmed clean.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_profile_same_workspace_fk" FOREIGN KEY ("workspace_id", "agent_profile_id") REFERENCES "public"."agent_profiles"("workspace_id", "id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_profile_same_workspace_fk" FOREIGN KEY ("workspace_id", "agent_profile_id") REFERENCES "public"."agent_profiles"("workspace_id", "id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_same_workspace_fk" FOREIGN KEY ("workspace_id", "thread_id") REFERENCES "public"."threads"("workspace_id", "id") ON DELETE set null ("thread_id") ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_same_workspace_fk" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "public"."agent_runs"("workspace_id", "id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_artifact_same_workspace_fk" FOREIGN KEY ("workspace_id", "artifact_id") REFERENCES "public"."artifacts"("workspace_id", "id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
CREATE TABLE "runtime_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"provider_execution_id" text,
	"workflow_version" text NOT NULL,
	"dispatch_key" text NOT NULL,
	"dispatch_state" text DEFAULT 'planned' NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"uncertain_since" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"redacted_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "runtime_executions_generation_positive" CHECK ("generation" >= 1),
	CONSTRAINT "runtime_executions_state_check" CHECK ("dispatch_state" in ('planned', 'dispatching', 'dispatched', 'unknown', 'rejected', 'completed', 'failed')),
	CONSTRAINT "runtime_executions_bound_check" CHECK ("dispatch_state" not in ('dispatched', 'completed') OR "provider_execution_id" IS NOT NULL),
	CONSTRAINT "runtime_executions_unknown_check" CHECK ("dispatch_state" <> 'unknown' OR "uncertain_since" IS NOT NULL),
	CONSTRAINT "runtime_executions_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_executions_run_fk" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "public"."agent_runs"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_executions_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
	CONSTRAINT "runtime_executions_run_generation_key" UNIQUE ("run_id", "generation"),
	CONSTRAINT "runtime_executions_dispatch_key_key" UNIQUE ("workspace_id", "dispatch_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_executions_provider_identity_key" ON "runtime_executions" USING btree ("workspace_id", "provider", "environment", "provider_execution_id") WHERE "provider_execution_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "runtime_executions_open_idx" ON "runtime_executions" USING btree ("workspace_id", "dispatch_state") WHERE "dispatch_state" in ('dispatching', 'unknown');
--> statement-breakpoint
CREATE FUNCTION "runtime_executions_freeze_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."run_id" <> OLD."run_id" OR NEW."generation" <> OLD."generation" OR NEW."provider" <> OLD."provider"
		OR NEW."environment" <> OLD."environment" OR NEW."workflow_version" <> OLD."workflow_version"
		OR NEW."dispatch_key" <> OLD."dispatch_key" THEN
		RAISE EXCEPTION 'runtime_executions routing identity is immutable' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD."provider_execution_id" IS NOT NULL AND NEW."provider_execution_id" IS DISTINCT FROM OLD."provider_execution_id" THEN
		RAISE EXCEPTION 'provider_execution_id is bound once' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "runtime_executions_freeze_identity" BEFORE UPDATE ON "runtime_executions" FOR EACH ROW EXECUTE FUNCTION "runtime_executions_freeze_identity"();
--> statement-breakpoint
CREATE TABLE "runtime_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"signal_key" text NOT NULL,
	"signal_type" text NOT NULL,
	"payload_revision" integer DEFAULT 1 NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"reconcile_note" text,
	"redacted_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_signals_revision_positive" CHECK ("payload_revision" >= 1),
	CONSTRAINT "runtime_signals_attempts_check" CHECK ("attempts" >= 0),
	CONSTRAINT "runtime_signals_status_check" CHECK ("status" in ('pending', 'sending', 'delivered', 'failed', 'unknown')),
	CONSTRAINT "runtime_signals_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_signals_execution_fk" FOREIGN KEY ("workspace_id", "execution_id") REFERENCES "public"."runtime_executions"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_signals_identity_key" UNIQUE ("execution_id", "signal_key")
);
--> statement-breakpoint
CREATE INDEX "runtime_signals_open_idx" ON "runtime_signals" USING btree ("workspace_id", "status") WHERE "status" in ('pending', 'sending', 'unknown');
--> statement-breakpoint
CREATE FUNCTION "runtime_signals_freeze_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."execution_id" <> OLD."execution_id" OR NEW."signal_key" <> OLD."signal_key"
		OR NEW."payload_revision" <> OLD."payload_revision" OR NEW."payload_hash" <> OLD."payload_hash" THEN
		RAISE EXCEPTION 'runtime_signals identity and payload are immutable' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "runtime_signals_freeze_identity" BEFORE UPDATE ON "runtime_signals" FOR EACH ROW EXECUTE FUNCTION "runtime_signals_freeze_identity"();
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"execution_id" uuid,
	"invocation_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"account_alias" text,
	"effect_class" text DEFAULT 'read' NOT NULL,
	"arguments_hash" text NOT NULL,
	"redacted_arguments" jsonb,
	"redacted_result" jsonb,
	"state" text DEFAULT 'requested' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_state_check" CHECK ("state" in ('requested', 'in_flight', 'succeeded', 'failed', 'unknown')),
	CONSTRAINT "tool_invocations_effect_check" CHECK ("effect_class" in ('read', 'internal_write', 'external_effect', 'paid')),
	CONSTRAINT "tool_invocations_terminal_check" CHECK ("state" not in ('succeeded', 'failed') OR "completed_at" IS NOT NULL),
	CONSTRAINT "tool_invocations_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "tool_invocations_run_fk" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "public"."agent_runs"("workspace_id", "id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "tool_invocations_execution_fk" FOREIGN KEY ("workspace_id", "execution_id") REFERENCES "public"."runtime_executions"("workspace_id", "id") ON DELETE set null ("execution_id") ON UPDATE no action,
	CONSTRAINT "tool_invocations_identity_key" UNIQUE ("run_id", "invocation_id")
);
--> statement-breakpoint
CREATE INDEX "tool_invocations_unsettled_idx" ON "tool_invocations" USING btree ("workspace_id", "state") WHERE "state" in ('in_flight', 'unknown');
--> statement-breakpoint
CREATE FUNCTION "tool_invocations_freeze_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."run_id" <> OLD."run_id" OR NEW."invocation_id" <> OLD."invocation_id" OR NEW."tool_name" <> OLD."tool_name"
		OR NEW."arguments_hash" <> OLD."arguments_hash" OR NEW."effect_class" <> OLD."effect_class" THEN
		RAISE EXCEPTION 'tool_invocations request identity is immutable' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD."state" IN ('succeeded', 'failed') AND NEW."state" <> OLD."state" THEN
		RAISE EXCEPTION 'tool_invocations terminal state is final' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tool_invocations_freeze_identity" BEFORE UPDATE ON "tool_invocations" FOR EACH ROW EXECUTE FUNCTION "tool_invocations_freeze_identity"();
