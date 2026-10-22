-- 0229: per-connector agent access tiers. The capability lists are the
-- enforcement source; integration_catalog.access_tiers mirrors
-- PROVIDER_TIERS in capabilities.ts for the UI. Providers whose read tools
-- have not shipped keep empty tiers and render "Coming soon" — they are not
-- connectable until a slice adds their tools.
ALTER TABLE "integration_catalog"
  ADD COLUMN IF NOT EXISTS "access_tiers" jsonb NOT NULL DEFAULT '[]';

-- Nullable per the tier contract (unset is a valid state), but new accounts
-- default to the narrowest offer: read-only until the owner grants more.
ALTER TABLE "external_accounts"
  ADD COLUMN IF NOT EXISTS "access_tier" text DEFAULT 'read_only';

-- Every account that existed before tiers did keeps the narrowest offer.
UPDATE external_accounts SET access_tier = 'read_only' WHERE access_tier IS NULL;

-- Tier offers for the four providers whose read tools have shipped. The
-- capability ids are the enforcement source; keep them in step with
-- PROVIDER_TIERS in capabilities.ts.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search and read mail.","capabilities":["gmail.read","gmail.thread.read"]},{"id":"read_send","label":"Read + send proposals","description":"Agents can also draft send proposals for your approval.","capabilities":["gmail.read","gmail.thread.read","gmail.send"]}]'::jsonb
WHERE provider = 'gmail';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search repositories and read issues.","capabilities":["github.read","github.issue.read"]}]'::jsonb
WHERE provider = 'github';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list channels and read messages.","capabilities":["slack.channels.read","slack.read"]}]'::jsonb
WHERE provider = 'slack';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search and read issues.","capabilities":["linear.read","linear.issue.read"]}]'::jsonb
WHERE provider = 'linear';
