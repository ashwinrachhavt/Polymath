CREATE TYPE "public"."attempt_status" AS ENUM('succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_state" AS ENUM('not_needed', 'pending', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approved', 'rejected', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."risk_class" AS ENUM('read', 'prepare', 'external_write', 'sensitive_write', 'prohibited');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('proposed', 'accepted', 'rejected', 'retired');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."question_state" AS ENUM('open', 'answered', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'waiting_input', 'waiting_approval', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."step_kind" AS ENUM('model', 'tool', 'question', 'proposal', 'artifact', 'note');--> statement-breakpoint
CREATE TYPE "public"."material_kind" AS ENUM('resume', 'cover_letter', 'portfolio', 'answer', 'other');--> statement-breakpoint
CREATE TYPE "public"."preparation_status" AS ENUM('draft', 'gathering', 'generating', 'ready', 'failed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."snapshot_kind" AS ENUM('form_fields', 'job_description', 'requirements', 'confirmation');--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('user', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'dispatched', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processing', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."attendee_response" AS ENUM('needs_action', 'accepted', 'declined', 'tentative');--> statement-breakpoint
CREATE TYPE "public"."calendar_kind" AS ENUM('local', 'external');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('confirmed', 'tentative', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."schedule_proposal_status" AS ENUM('proposed', 'applied', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."capture_kind" AS ENUM('text', 'url', 'file', 'voice', 'forwarded');--> statement-breakpoint
CREATE TYPE "public"."capture_processing_state" AS ENUM('unprocessed', 'classifying', 'enriched', 'converted', 'discarded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."capture_proposal_kind" AS ENUM('task', 'note', 'project', 'contact', 'company', 'opportunity', 'reference', 'event', 'discard');--> statement-breakpoint
CREATE TYPE "public"."capture_proposal_status" AS ENUM('pending', 'accepted', 'edited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."capture_source" AS ENUM('quick_capture', 'email', 'webhook', 'companion', 'import', 'api');--> statement-breakpoint
CREATE TYPE "public"."correspondence_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."correspondence_state" AS ENUM('planned', 'drafted', 'sent', 'received', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('open', 'done', 'cancelled', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."observation_source" AS ENUM('stated', 'document', 'observed', 'agent_inferred');--> statement-breakpoint
CREATE TYPE "public"."relationship_status" AS ENUM('unknown', 'cold', 'warm', 'active', 'dormant');--> statement-breakpoint
CREATE TYPE "public"."focus_session_state" AS ENUM('running', 'paused', 'interrupted', 'finished', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('outcome_completed', 'focus_completed', 'task_completed', 'review_decided', 'learning_reviewed', 'weekly_review', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."reward_kind" AS ENUM('points', 'streak_day', 'badge', 'collectible');--> statement-breakpoint
CREATE TYPE "public"."api_client_kind" AS ENUM('companion', 'machine');--> statement-breakpoint
CREATE TYPE "public"."api_client_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."appearance" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."motion_preference" AS ENUM('full', 'reduced');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('connecting', 'active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."sync_state" AS ENUM('idle', 'running', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trigger_status" AS ENUM('enabled', 'paused', 'errored', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('note', 'document', 'memo', 'report', 'diagram', 'transcript', 'other');--> statement-breakpoint
CREATE TYPE "public"."artifact_status" AS ENUM('draft', 'generated', 'reviewed', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('proposed', 'accepted', 'rejected', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."concept_sense" AS ENUM('ordinary', 'technical', 'domain');--> statement-breakpoint
CREATE TYPE "public"."document_decision" AS ENUM('keep', 'rename', 'classify', 'link', 'discard');--> statement-breakpoint
CREATE TYPE "public"."dossier_question_status" AS ENUM('open', 'answered', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."dossier_source_policy" AS ENUM('bounded', 'open');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('uploaded', 'imported', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."version_reason" AS ENUM('created', 'edited', 'generated', 'imported', 'restored', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."learning_item_kind" AS ENUM('flashcard', 'quiz_question', 'exercise');--> statement-breakpoint
CREATE TYPE "public"."learning_item_status" AS ENUM('proposed', 'approved', 'retired', 'stale');--> statement-breakpoint
CREATE TYPE "public"."learning_result" AS ENUM('forgot', 'struggled', 'recalled', 'explained', 'applied');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'paused', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."extension_kind" AS ENUM('job_application', 'consulting_lead', 'partnership');--> statement-breakpoint
CREATE TYPE "public"."opportunity_outcome" AS ENUM('pending', 'accepted', 'rejected', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."opportunity_stage" AS ENUM('identified', 'researching', 'preparing', 'submitted', 'interviewing', 'negotiating', 'won', 'lost', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('reserved', 'settled', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."dependency_kind" AS ENUM('blocks', 'blocked_by', 'waiting_on');--> statement-breakpoint
CREATE TYPE "public"."project_phase" AS ENUM('proposed', 'active', 'paused', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."recurrence_cadence" AS ENUM('daily', 'weekly', 'monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('none', 'low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('inbox', 'backlog', 'ready', 'in_progress', 'waiting', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "action_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" "attempt_status" NOT NULL,
	"response_summary" jsonb,
	"error_code" text,
	"reconciliation" "reconciliation_state" DEFAULT 'not_needed' NOT NULL,
	"provider_object_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"risk_class" "risk_class" NOT NULL,
	"auto_execute" boolean DEFAULT false NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"risk_class" "risk_class" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"account_alias" text,
	"title" text NOT NULL,
	"expected_effect" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"run_id" uuid,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"revision_of" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"note" text,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"preview" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"paused_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attempt_id" uuid,
	"proposal_id" uuid,
	"provider" text NOT NULL,
	"provider_object_id" text,
	"observed_state" text NOT NULL,
	"detail" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"instructions" text,
	"model_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"memory_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"question" text NOT NULL,
	"context" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" "question_state" DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid,
	"agent_profile_id" uuid NOT NULL,
	"retry_of_run_id" uuid,
	"objective" text NOT NULL,
	"subjects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"model" text,
	"summary" text,
	"error" text,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "step_kind" NOT NULL,
	"summary" text,
	"payload" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"body" text NOT NULL,
	"status" "memory_status" DEFAULT 'proposed' NOT NULL,
	"produced_by_run_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"memory_item_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"memory_item_id" uuid NOT NULL,
	"body" text NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text,
	"parts" jsonb,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid,
	"label" text,
	"summary" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"title" text,
	"subject_type" text,
	"subject_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"tool_name" text NOT NULL,
	"account_alias" text,
	"arguments" jsonb,
	"result" jsonb,
	"ok" boolean,
	"error_code" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"kind" "material_kind" NOT NULL,
	"label" text,
	"selected" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"status" "preparation_status" DEFAULT 'draft' NOT NULL,
	"keyword_analysis" jsonb,
	"run_id" uuid,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"kind" "snapshot_kind" NOT NULL,
	"url" text,
	"content_hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_kind" "actor_kind" DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"summary" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"retention_class" text DEFAULT 'standard' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"event_type" text,
	"payload" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "calendar_kind" DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"timezone" text,
	"external_account_id" uuid,
	"provider_object_id" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"email" text,
	"display_name" text,
	"contact_id" uuid,
	"response" "attendee_response" DEFAULT 'needs_action' NOT NULL,
	"organizer" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"timezone" text,
	"status" "event_status" DEFAULT 'confirmed' NOT NULL,
	"external_account_id" uuid,
	"provider_object_id" text,
	"provider_etag" text,
	"recurrence_rule" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"proposed_start_at" timestamp with time zone NOT NULL,
	"proposed_end_at" timestamp with time zone NOT NULL,
	"rationale" text,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "schedule_proposal_status" DEFAULT 'proposed' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"working_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_meeting_minutes" integer DEFAULT 30 NOT NULL,
	"buffer_minutes" integer DEFAULT 10 NOT NULL,
	"earliest_minute" integer DEFAULT 540 NOT NULL,
	"latest_minute" integer DEFAULT 1080 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"kind" "capture_proposal_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text,
	"source_spans" jsonb,
	"model" text,
	"prompt_version" text,
	"confidence" text,
	"status" "capture_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"result_type" text,
	"result_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "capture_kind" NOT NULL,
	"source" "capture_source" DEFAULT 'quick_capture' NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"text" text,
	"url" text,
	"blob_id" uuid,
	"processing_state" "capture_processing_state" DEFAULT 'unprocessed' NOT NULL,
	"converted_type" text,
	"converted_id" uuid,
	"converted_at" timestamp with time zone,
	"failure_reason" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"description" text,
	"attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"body" text NOT NULL,
	"source" "observation_source" NOT NULL,
	"evidence_type" text,
	"evidence_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"primary_email" text,
	"phone" text,
	"title" text,
	"location" text,
	"relationship_status" "relationship_status" DEFAULT 'unknown' NOT NULL,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"project_id" uuid,
	"direction" "correspondence_direction" NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text,
	"body" text,
	"state" "correspondence_state" DEFAULT 'planned' NOT NULL,
	"external_account_id" uuid,
	"provider_object_id" text,
	"thread_id" text,
	"action_proposal_id" uuid,
	"occurred_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"task_id" uuid,
	"due_at" timestamp with time zone,
	"note" text,
	"status" "follow_up_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid,
	"subject" text,
	"state" "focus_session_state" DEFAULT 'running' NOT NULL,
	"planned_minutes" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_resumed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"accumulated_seconds" integer DEFAULT 0 NOT NULL,
	"interruptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"outcomes_accepted" integer DEFAULT 0 NOT NULL,
	"outcomes_completed" integer DEFAULT 0 NOT NULL,
	"focus_minutes" integer DEFAULT 0 NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	"reviews_decided" integer DEFAULT 0 NOT NULL,
	"captures_processed" integer DEFAULT 0 NOT NULL,
	"points_earned" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" "reward_kind" NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"points" integer DEFAULT 0 NOT NULL,
	"threshold" integer DEFAULT 1 NOT NULL,
	"accessibility_label" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reward_definition_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" "ledger_reason" NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"points" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"total_points" integer DEFAULT 0 NOT NULL,
	"current_streak_days" integer DEFAULT 0 NOT NULL,
	"longest_streak_days" integer DEFAULT 0 NOT NULL,
	"badges" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_active_on" date,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "api_client_kind" DEFAULT 'companion' NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "api_client_status" DEFAULT 'active' NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'owner' NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"week_start" smallint DEFAULT 1 NOT NULL,
	"appearance" "appearance" DEFAULT 'system' NOT NULL,
	"motion" "motion_preference" DEFAULT 'full' NOT NULL,
	"notification_policy" jsonb,
	"model_defaults" jsonb,
	"budget_defaults" jsonb,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"avatar_url" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_personal" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "external_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"alias" text NOT NULL,
	"composio_connected_account_id" text,
	"provider_account_id" text,
	"display_name" text,
	"scopes_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "account_status" DEFAULT 'connecting' NOT NULL,
	"is_default_for_writes" boolean DEFAULT false NOT NULL,
	"last_healthy_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_by_capability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"cursor" text,
	"state" "sync_state" DEFAULT 'idle' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_account_id" uuid,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"composio_trigger_id" text,
	"status" "trigger_status" DEFAULT 'paused' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_fired_at" timestamp with time zone,
	"fire_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"plain_text" text,
	"reason" "version_reason" DEFAULT 'edited' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "artifact_kind" DEFAULT 'note' NOT NULL,
	"title" text NOT NULL,
	"status" "artifact_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"produced_by_run_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canvas_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"scene" jsonb NOT NULL,
	"element_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"extraction_id" uuid,
	"quote" text,
	"start_offset" integer,
	"end_offset" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"status" "claim_status" DEFAULT 'proposed' NOT NULL,
	"artifact_id" uuid,
	"confidence" text,
	"produced_by_run_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"term" text NOT NULL,
	"sense" "concept_sense" DEFAULT 'ordinary' NOT NULL,
	"domain" text,
	"definition" text,
	"source_id" uuid,
	"source_quote" text,
	"annotation" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"decision" "document_decision" NOT NULL,
	"proposed" jsonb,
	"applied" jsonb,
	"model" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"status" "extraction_status" DEFAULT 'pending' NOT NULL,
	"text" text,
	"spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extractor" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid,
	"artifact_id" uuid,
	"title" text NOT NULL,
	"mime_type" text,
	"page_count" integer,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dossier_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dossier_id" uuid NOT NULL,
	"question" text NOT NULL,
	"status" "dossier_question_status" DEFAULT 'open' NOT NULL,
	"answer" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dossier_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dossier_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"pinned_content_hash" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"research_question" text,
	"source_policy" "dossier_source_policy" DEFAULT 'bounded' NOT NULL,
	"project_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_version_id" uuid,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"status" "file_status" DEFAULT 'uploaded' NOT NULL,
	"origin" text DEFAULT 'upload' NOT NULL,
	"external_account_id" uuid,
	"provider_object_id" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"url" text,
	"file_id" uuid,
	"content_hash" text,
	"fetched_at" timestamp with time zone,
	"provider_request_id" text,
	"metadata" jsonb,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "working_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"base_version_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"focus_session_id" uuid,
	"result" "learning_result" NOT NULL,
	"response_text" text,
	"duration_ms" integer,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_artifact_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deck_id" uuid,
	"kind" "learning_item_kind" DEFAULT 'flashcard' NOT NULL,
	"prompt" text NOT NULL,
	"answer" text,
	"source_type" text,
	"source_id" uuid,
	"source_quote" text,
	"status" "learning_item_status" DEFAULT 'proposed' NOT NULL,
	"due_on" date,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"ease_factor" text DEFAULT '2.5' NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"stale_reason" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"objective" text,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"deck_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_date" date,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"company_id" uuid,
	"primary_contact_id" uuid,
	"why_it_matters" text,
	"stage" "opportunity_stage" DEFAULT 'identified' NOT NULL,
	"outcome" "opportunity_outcome" DEFAULT 'pending' NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"fit_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_commitment" text,
	"next_commitment_at" timestamp with time zone,
	"outcome_evidence" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"label" text NOT NULL,
	"due_on" date,
	"met_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"kind" "extension_kind" NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_stage" "opportunity_stage",
	"to_stage" "opportunity_stage" NOT NULL,
	"note" text,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_per_million" numeric(12, 6) NOT NULL,
	"output_per_million" numeric(12, 6) NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"run_id" uuid,
	"amount_usd" numeric(12, 6) NOT NULL,
	"model" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spending_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"daily_ceiling_usd" numeric(12, 4),
	"monthly_ceiling_usd" numeric(12, 4),
	"per_run_ceiling_usd" numeric(12, 4),
	"on_exceeded" text DEFAULT 'pause' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spending_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"reserved_usd" numeric(12, 6) NOT NULL,
	"settled_usd" numeric(12, 6),
	"status" "reservation_status" DEFAULT 'reserved' NOT NULL,
	"model" text,
	"expires_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"wip_limit" integer,
	"rank" text DEFAULT 'm' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"group_by" text DEFAULT 'status' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"rationale" text,
	"rank" text DEFAULT 'm' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid,
	"name" text NOT NULL,
	"intended_outcome" text,
	"description" text,
	"phase" "project_phase" DEFAULT 'proposed' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completion_criteria" text,
	"next_review_at" timestamp with time zone,
	"target_date" date,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurrence_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"cadence" "recurrence_cadence" NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"rule" jsonb,
	"next_occurrence_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"view" text DEFAULT 'list' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"rank" text DEFAULT 'm' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" "dependency_kind" NOT NULL,
	"depends_on_task_id" uuid,
	"waiting_on_type" text,
	"waiting_on_id" uuid,
	"note" text,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"space_id" uuid,
	"parent_task_id" uuid,
	"recurrence_template_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'inbox' NOT NULL,
	"priority" "task_priority" DEFAULT 'none' NOT NULL,
	"rank" text DEFAULT 'm' NOT NULL,
	"planned_start_at" timestamp with time zone,
	"planned_end_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"estimate_minutes" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"action_proposal_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_attempts" ADD CONSTRAINT "action_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_attempts" ADD CONSTRAINT "action_attempts_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_attempts" ADD CONSTRAINT "action_attempts_revision_id_action_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."action_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_policies" ADD CONSTRAINT "action_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_reviews" ADD CONSTRAINT "action_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_reviews" ADD CONSTRAINT "action_reviews_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_reviews" ADD CONSTRAINT "action_reviews_revision_id_action_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."action_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_revisions" ADD CONSTRAINT "action_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_revisions" ADD CONSTRAINT "action_revisions_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_settings" ADD CONSTRAINT "execution_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD CONSTRAINT "provider_observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD CONSTRAINT "provider_observations_attempt_id_action_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."action_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_observations" ADD CONSTRAINT "provider_observations_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reviews" ADD CONSTRAINT "memory_reviews_memory_item_id_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_item_id_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_checkpoints" ADD CONSTRAINT "thread_checkpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_checkpoints" ADD CONSTRAINT "thread_checkpoints_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_step_id_agent_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."agent_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_preparation_id_application_preparations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."application_preparations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_materials" ADD CONSTRAINT "application_materials_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_preparations" ADD CONSTRAINT "application_preparations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_preparations" ADD CONSTRAINT "application_preparations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_snapshots" ADD CONSTRAINT "application_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_snapshots" ADD CONSTRAINT "application_snapshots_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_objects" ADD CONSTRAINT "blob_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_receipts" ADD CONSTRAINT "request_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_proposals" ADD CONSTRAINT "schedule_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_preferences" ADD CONSTRAINT "scheduler_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_proposals" ADD CONSTRAINT "capture_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_proposals" ADD CONSTRAINT "capture_proposals_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_blob_id_blob_objects_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blob_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_observations" ADD CONSTRAINT "contact_observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_observations" ADD CONSTRAINT "contact_observations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD CONSTRAINT "daily_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_definitions" ADD CONSTRAINT "reward_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_reward_definition_id_reward_definitions_id_fk" FOREIGN KEY ("reward_definition_id") REFERENCES "public"."reward_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_external_account_id_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."external_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_external_account_id_external_accounts_id_fk" FOREIGN KEY ("external_account_id") REFERENCES "public"."external_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_versions" ADD CONSTRAINT "canvas_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_versions" ADD CONSTRAINT "canvas_versions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_decisions" ADD CONSTRAINT "document_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_decisions" ADD CONSTRAINT "document_decisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_questions" ADD CONSTRAINT "dossier_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_questions" ADD CONSTRAINT "dossier_questions_dossier_id_dossiers_id_fk" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_sources" ADD CONSTRAINT "dossier_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_sources" ADD CONSTRAINT "dossier_sources_dossier_id_dossiers_id_fk" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_sources" ADD CONSTRAINT "dossier_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_blob_id_blob_objects_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blob_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_copies" ADD CONSTRAINT "recovery_copies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_copies" ADD CONSTRAINT "recovery_copies_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_drafts" ADD CONSTRAINT "working_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_drafts" ADD CONSTRAINT "working_drafts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_item_id_learning_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."learning_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_decks" ADD CONSTRAINT "learning_decks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_decks" ADD CONSTRAINT "learning_decks_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_deck_id_learning_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."learning_decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_plans" ADD CONSTRAINT "learning_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_deadlines" ADD CONSTRAINT "opportunity_deadlines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_deadlines" ADD CONSTRAINT "opportunity_deadlines_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_extensions" ADD CONSTRAINT "opportunity_extensions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_extensions" ADD CONSTRAINT "opportunity_extensions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_rate_cards" ADD CONSTRAINT "model_rate_cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_settlements" ADD CONSTRAINT "spend_settlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_settlements" ADD CONSTRAINT "spend_settlements_reservation_id_spending_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."spending_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_policies" ADD CONSTRAINT "spending_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_outcomes" ADD CONSTRAINT "daily_outcomes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_outcomes" ADD CONSTRAINT "daily_outcomes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_templates" ADD CONSTRAINT "recurrence_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_templates" ADD CONSTRAINT "recurrence_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurrence_template_id_recurrence_templates_id_fk" FOREIGN KEY ("recurrence_template_id") REFERENCES "public"."recurrence_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_attempts_number_key" ON "action_attempts" USING btree ("proposal_id","attempt_number");--> statement-breakpoint
CREATE INDEX "action_attempts_unresolved_idx" ON "action_attempts" USING btree ("workspace_id","started_at") WHERE status = 'unknown' and reconciliation = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "action_policies_capability_key" ON "action_policies" USING btree ("workspace_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_dedupe_key" ON "action_proposals" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "action_proposals_pending_idx" ON "action_proposals" USING btree ("workspace_id","created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "action_reviews_proposal_idx" ON "action_reviews" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_revisions_number_key" ON "action_revisions" USING btree ("proposal_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_settings_workspace_key" ON "execution_settings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "provider_observations_proposal_idx" ON "provider_observations" USING btree ("proposal_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_workspace_name_key" ON "agent_profiles" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "agent_questions_open_idx" ON "agent_questions" USING btree ("workspace_id","state","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_workspace_created_idx" ON "agent_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_active_idx" ON "agent_runs" USING btree ("workspace_id","state") WHERE state in ('queued', 'running', 'waiting_input', 'waiting_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_run_sequence_key" ON "agent_steps" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "memory_items_status_idx" ON "memory_items" USING btree ("workspace_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "memory_reviews_item_idx" ON "memory_reviews" USING btree ("memory_item_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_revisions_item_idx" ON "memory_revisions" USING btree ("memory_item_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_artifacts_key" ON "run_artifacts" USING btree ("run_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_sequence_key" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "thread_checkpoints_thread_idx" ON "thread_checkpoints" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_workspace_updated_idx" ON "threads" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "threads_subject_idx" ON "threads" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "application_materials_key" ON "application_materials" USING btree ("preparation_id","artifact_id","kind");--> statement-breakpoint
CREATE INDEX "application_preparations_opportunity_idx" ON "application_preparations" USING btree ("workspace_id","opportunity_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "application_snapshots_hash_key" ON "application_snapshots" USING btree ("opportunity_id","kind","content_hash");--> statement-breakpoint
CREATE INDEX "application_snapshots_opportunity_idx" ON "application_snapshots" USING btree ("opportunity_id","captured_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blob_objects_storage_key" ON "blob_objects" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "blob_objects_workspace_hash_idx" ON "blob_objects" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "request_receipts_workspace_key" ON "request_receipts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_provider_delivery_key" ON "webhook_inbox" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_unprocessed_idx" ON "webhook_inbox" USING btree ("created_at") WHERE status in ('received', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_workspace_name_key" ON "calendars" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_external_key" ON "calendars" USING btree ("external_account_id","provider_object_id") WHERE provider_object_id is not null;--> statement-breakpoint
CREATE INDEX "event_attendees_event_idx" ON "event_attendees" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_email_key" ON "event_attendees" USING btree ("event_id","email") WHERE email is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "event_links_edge_key" ON "event_links" USING btree ("event_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "event_links_target_idx" ON "event_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "events_calendar_range_idx" ON "events" USING btree ("calendar_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "events_workspace_range_idx" ON "events" USING btree ("workspace_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_external_key" ON "events" USING btree ("external_account_id","provider_object_id") WHERE provider_object_id is not null;--> statement-breakpoint
CREATE INDEX "schedule_proposals_pending_idx" ON "schedule_proposals" USING btree ("workspace_id","status","proposed_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduler_preferences_workspace_key" ON "scheduler_preferences" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "capture_proposals_pending_idx" ON "capture_proposals" USING btree ("workspace_id","capture_id","status");--> statement-breakpoint
CREATE INDEX "captures_inbox_idx" ON "captures" USING btree ("workspace_id","created_at") WHERE processing_state in ('unprocessed', 'classifying');--> statement-breakpoint
CREATE UNIQUE INDEX "captures_workspace_source_url_key" ON "captures" USING btree ("workspace_id","source","url") WHERE url is not null;--> statement-breakpoint
CREATE INDEX "companies_workspace_name_idx" ON "companies" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_workspace_domain_key" ON "companies" USING btree ("workspace_id","domain") WHERE domain is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_companies_key" ON "contact_companies" USING btree ("contact_id","company_id","started_at");--> statement-breakpoint
CREATE INDEX "contact_observations_contact_idx" ON "contact_observations" USING btree ("contact_id","observed_at");--> statement-breakpoint
CREATE INDEX "contacts_workspace_name_idx" ON "contacts" USING btree ("workspace_id","full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_workspace_email_key" ON "contacts" USING btree ("workspace_id","primary_email") WHERE primary_email is not null;--> statement-breakpoint
CREATE INDEX "correspondence_contact_idx" ON "correspondence" USING btree ("workspace_id","contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "correspondence_state_idx" ON "correspondence" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_provider_key" ON "correspondence" USING btree ("external_account_id","provider_object_id") WHERE provider_object_id is not null;--> statement-breakpoint
CREATE INDEX "follow_ups_open_idx" ON "follow_ups" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "focus_sessions_workspace_started_idx" ON "focus_sessions" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "focus_sessions_active_idx" ON "focus_sessions" USING btree ("workspace_id") WHERE state in ('running', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "daily_snapshots_day_key" ON "daily_snapshots" USING btree ("workspace_id","user_id","on_date");--> statement-breakpoint
CREATE INDEX "daily_snapshots_range_idx" ON "daily_snapshots" USING btree ("workspace_id","on_date");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_definitions_key" ON "reward_definitions" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_ledger_idempotency_key" ON "reward_ledger" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reward_ledger_workspace_created_idx" ON "reward_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_progress_workspace_user_key" ON "user_progress" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "api_clients_workspace_status_idx" ON "api_clients" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_user_key" ON "memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_workspace_user_key" ON "user_preferences" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_accounts_alias_key" ON "external_accounts" USING btree ("workspace_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "external_accounts_composio_key" ON "external_accounts" USING btree ("composio_connected_account_id") WHERE composio_connected_account_id is not null;--> statement-breakpoint
CREATE INDEX "external_accounts_provider_idx" ON "external_accounts" USING btree ("workspace_id","provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_catalog_provider_key" ON "integration_catalog" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursors_resource_key" ON "sync_cursors" USING btree ("external_account_id","resource");--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_instance_key" ON "triggers" USING btree ("composio_trigger_id") WHERE composio_trigger_id is not null;--> statement-breakpoint
CREATE INDEX "triggers_active_idx" ON "triggers" USING btree ("workspace_id","status","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_links_edge_key" ON "artifact_links" USING btree ("artifact_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "artifact_links_target_idx" ON "artifact_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_number_key" ON "artifact_versions" USING btree ("artifact_id","version_number");--> statement-breakpoint
CREATE INDEX "artifact_versions_artifact_idx" ON "artifact_versions" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_workspace_kind_idx" ON "artifacts" USING btree ("workspace_id","kind","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_versions_number_key" ON "canvas_versions" USING btree ("canvas_id","version_number");--> statement-breakpoint
CREATE INDEX "canvases_workspace_updated_idx" ON "canvases" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "claim_evidence_claim_idx" ON "claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claims_workspace_status_idx" ON "claims" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "claims_artifact_idx" ON "claims" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_workspace_term_sense_key" ON "concepts" USING btree ("workspace_id","term","sense");--> statement-breakpoint
CREATE INDEX "document_decisions_document_idx" ON "document_decisions" USING btree ("document_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_extractions_content_key" ON "document_extractions" USING btree ("document_id","content_hash");--> statement-breakpoint
CREATE INDEX "document_extractions_pending_idx" ON "document_extractions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "documents_workspace_created_idx" ON "documents" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "dossier_questions_open_idx" ON "dossier_questions" USING btree ("dossier_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dossier_sources_key" ON "dossier_sources" USING btree ("dossier_id","source_id");--> statement-breakpoint
CREATE INDEX "dossiers_workspace_updated_idx" ON "dossiers" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_owner_chunk_key" ON "embeddings" USING btree ("owner_type","owner_id","model","chunk_index");--> statement-breakpoint
CREATE INDEX "embeddings_workspace_idx" ON "embeddings" USING btree ("workspace_id","owner_type");--> statement-breakpoint
CREATE INDEX "embeddings_vector_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "files_workspace_created_idx" ON "files" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "files_external_key" ON "files" USING btree ("external_account_id","provider_object_id") WHERE provider_object_id is not null;--> statement-breakpoint
CREATE INDEX "recovery_copies_artifact_idx" ON "recovery_copies" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_workspace_url_hash_key" ON "sources" USING btree ("workspace_id","url","content_hash") WHERE url is not null and content_hash is not null;--> statement-breakpoint
CREATE INDEX "sources_workspace_kind_idx" ON "sources" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "working_drafts_artifact_key" ON "working_drafts" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "learning_attempts_item_idx" ON "learning_attempts" USING btree ("item_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_decks_workspace_name_key" ON "learning_decks" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "learning_items_due_idx" ON "learning_items" USING btree ("workspace_id","due_on") WHERE status = 'approved';--> statement-breakpoint
CREATE INDEX "learning_items_deck_idx" ON "learning_items" USING btree ("deck_id");--> statement-breakpoint
CREATE INDEX "learning_plans_active_idx" ON "learning_plans" USING btree ("workspace_id","status","target_date");--> statement-breakpoint
CREATE INDEX "opportunities_stage_idx" ON "opportunities" USING btree ("workspace_id","stage","updated_at");--> statement-breakpoint
CREATE INDEX "opportunities_company_idx" ON "opportunities" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_deadlines_key" ON "opportunity_deadlines" USING btree ("opportunity_id","label");--> statement-breakpoint
CREATE INDEX "opportunity_deadlines_due_idx" ON "opportunity_deadlines" USING btree ("workspace_id","due_on") WHERE met_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_extensions_kind_key" ON "opportunity_extensions" USING btree ("opportunity_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_links_edge_key" ON "opportunity_links" USING btree ("opportunity_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "opportunity_links_target_idx" ON "opportunity_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "opportunity_stage_history_idx" ON "opportunity_stage_history" USING btree ("opportunity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_rate_cards_key" ON "model_rate_cards" USING btree ("workspace_id","provider","model","effective_from");--> statement-breakpoint
CREATE INDEX "spend_settlements_reservation_idx" ON "spend_settlements" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spending_policies_workspace_key" ON "spending_policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "spending_reservations_open_idx" ON "spending_reservations" USING btree ("workspace_id","created_at") WHERE status = 'reserved';--> statement-breakpoint
CREATE INDEX "spending_reservations_run_idx" ON "spending_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_columns_board_value_key" ON "board_columns" USING btree ("board_id","value");--> statement-breakpoint
CREATE UNIQUE INDEX "boards_workspace_name_key" ON "boards" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "daily_outcomes_day_idx" ON "daily_outcomes" USING btree ("workspace_id","on_date","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_outcomes_day_task_key" ON "daily_outcomes" USING btree ("workspace_id","on_date","task_id") WHERE task_id is not null;--> statement-breakpoint
CREATE INDEX "projects_workspace_phase_idx" ON "projects" USING btree ("workspace_id","phase");--> statement-breakpoint
CREATE INDEX "recurrence_templates_due_idx" ON "recurrence_templates" USING btree ("workspace_id","next_occurrence_at","active");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_workspace_name_key" ON "saved_views" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_workspace_name_key" ON "spaces" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_edge_key" ON "task_dependencies" USING btree ("task_id","kind","depends_on_task_id") WHERE depends_on_task_id is not null;--> statement-breakpoint
CREATE INDEX "task_dependencies_task_idx" ON "task_dependencies" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_reverse_idx" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_edge_key" ON "task_links" USING btree ("task_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "task_links_target_idx" ON "task_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "tasks_workspace_status_idx" ON "tasks" USING btree ("workspace_id","status","rank");--> statement-breakpoint
CREATE INDEX "tasks_workspace_due_idx" ON "tasks" USING btree ("workspace_id","due_at") WHERE status not in ('done', 'cancelled');--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");