-- 0247: tier offer for google-drive, which 0246 inserted a catalog row for
-- without setting its access_tiers. On databases where 0230's UPDATE matched
-- nothing (no row seeded before 0223), the drive card rendered Coming soon
-- forever. The capability ids are the enforcement source; keep in step with
-- PROVIDER_TIERS in capabilities.ts — tests/unit/provider-tiers.test.ts pins
-- the parity.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search the files in your Drive.","capabilities":["googledrive.files.read"]}]'::jsonb
WHERE provider = 'google-drive';
