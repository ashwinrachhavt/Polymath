-- 0222 (Task 7): the duplicate-send guard. An executor claims an attempt by
-- inserting its intent key as `unknown` before the provider call; the unique
-- index is what makes a second claim lose the race instead of producing a
-- second send. Existing attempts predate the key, so they are backfilled with
-- a value derived from the row id — unique, deterministic, and honest: those
-- rows never had an intent key and reconciliation must not confuse them with a
-- live claim.
ALTER TABLE "action_attempts" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
UPDATE "action_attempts" SET "idempotency_key" = 'legacy:' || "id"::text WHERE "idempotency_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "action_attempts" ALTER COLUMN "idempotency_key" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_attempts_idempotency_key" ON "action_attempts" USING btree ("workspace_id","idempotency_key");
