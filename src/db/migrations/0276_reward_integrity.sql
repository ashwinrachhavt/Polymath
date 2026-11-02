-- Spec §6 (reward integrity): re-scope the daily Quartz idempotency keys to
-- their users. Rows written before this migration carry the workspace-wide
-- key `quartz:<day>`; the contract is now `quartz:<userId>:<day>`. Backfill
-- first, so a user who earned Quartz this morning cannot earn it again
-- across the deploy: the user id is embedded, so no two rows can collide.
UPDATE "reward_ledger" SET "idempotency_key" = 'quartz:' || "user_id"::text || substring("idempotency_key" from 8) WHERE "user_id" IS NOT NULL AND "idempotency_key" ~ '^quartz:\d{4}-\d{2}-\d{2}$';--> statement-breakpoint
CREATE UNIQUE INDEX "reward_ledger_user_idempotency_key" ON "reward_ledger" USING btree ("workspace_id","user_id","idempotency_key");