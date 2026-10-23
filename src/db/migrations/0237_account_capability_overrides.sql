-- 0237: per-account fine-grained capability switches. The tier stays the
-- ceiling (0229); this list names capabilities from the account's tier that
-- the owner switched off for this one account. The gateway reads it live
-- with the tier on every call; the connect screen renders one switch per
-- tier capability. Default empty: every existing account keeps its tier's
-- full grant until the owner narrows it.
ALTER TABLE "external_accounts"
  ADD COLUMN IF NOT EXISTS "disabled_capabilities" jsonb NOT NULL DEFAULT '[]';
