-- Assessment item B: the finish record carries what changed and where to
-- resume, stored on the session (which is linked to the task), additive.
ALTER TABLE "focus_sessions" ADD COLUMN "what_changed" text;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "next_step" text;
