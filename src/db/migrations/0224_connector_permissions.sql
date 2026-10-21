-- 0224: per-account read and write permission. Read defaults on because an
-- account the owner connected is one they expect the agent to read; write
-- defaults off because a granted write is a decision, not a default. Nothing is
-- enforced by this migration - the executor reads these columns later.
ALTER TABLE "external_accounts"
  ADD COLUMN IF NOT EXISTS "allow_read" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "allow_write" boolean NOT NULL DEFAULT false;
