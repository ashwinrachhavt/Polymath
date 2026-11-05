-- 0285: drop the dead runtime execution/trace layer (ASH-117 residual).
--
-- The three tables stored dispatch/signal/invocation state machines whose
-- writer functions in runtime-persistence.ts had zero production callers
-- (grep-verified per symbol; the production agent path writes `tool_calls`).
-- CASCADE removes their trigger-immutable triggers and the runtime_signals /
-- tool_invocations foreign keys; the now-orphaned trigger functions go too.
-- `agent_profile_revisions` stays — captureProfileRevision still writes it.
--> statement-breakpoint
DROP TABLE IF EXISTS "runtime_executions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "runtime_signals" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tool_invocations" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS "runtime_executions_freeze_identity"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "runtime_signals_freeze_identity"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "tool_invocations_freeze_identity"();
