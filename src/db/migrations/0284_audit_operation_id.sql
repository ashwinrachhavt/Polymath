ALTER TABLE "audit_events" ADD COLUMN "operation_id" text;--> statement-breakpoint
CREATE INDEX "audit_events_operation_idx" ON "audit_events" USING btree ("workspace_id","operation_id");