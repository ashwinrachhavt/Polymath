DROP INDEX "focus_sessions_active_idx";--> statement-breakpoint
CREATE INDEX "agent_runs_thread_idx" ON "agent_runs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "run_artifacts_artifact_idx" ON "run_artifacts" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "threads_agent_profile_idx" ON "threads" USING btree ("agent_profile_id");--> statement-breakpoint
CREATE INDEX "application_materials_artifact_idx" ON "application_materials" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "contact_companies_company_idx" ON "contact_companies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "follow_ups_contact_idx" ON "follow_ups" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "follow_ups_company_idx" ON "follow_ups" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "reward_ledger_definition_idx" ON "reward_ledger" USING btree ("reward_definition_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_source_idx" ON "claim_evidence" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_extraction_idx" ON "claim_evidence" USING btree ("extraction_id");--> statement-breakpoint
CREATE INDEX "documents_file_idx" ON "documents" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "documents_artifact_idx" ON "documents" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "dossier_sources_source_idx" ON "dossier_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sources_file_idx" ON "sources" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "boards_project_idx" ON "boards" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_space_idx" ON "projects" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "recurrence_templates_project_idx" ON "recurrence_templates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_space_idx" ON "tasks" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "tasks_recurrence_template_idx" ON "tasks" USING btree ("recurrence_template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_sessions_active_idx" ON "focus_sessions" USING btree ("workspace_id") WHERE state in ('running', 'paused');--> statement-breakpoint
ALTER TABLE "event_links" ADD CONSTRAINT "event_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'opportunity', 'run', 'thread'));--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'opportunity', 'run', 'thread'));--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'opportunity', 'run', 'thread'));--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'opportunity', 'run', 'thread'));