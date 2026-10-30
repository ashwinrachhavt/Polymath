-- Review should-fix F: two concurrent create-stream POSTs could both pass the
-- "existing running run" pre-check and start two runs for one sitting. The
-- pre-check stays as the fast path; this partial unique index is the actual
-- guard: at most one RUNNING creation run per (workspace, sitting).
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_running_creation_per_sitting"
ON "agent_runs" ("workspace_id", ((subjects->0->>'sittingId')))
WHERE "objective" = 'zettel-sitting-creation' AND "state" = 'running';
