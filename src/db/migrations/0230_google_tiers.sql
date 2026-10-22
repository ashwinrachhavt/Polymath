-- 0230: tier offers for the Google cluster A (calendar, drive). Docs and
-- Sheets have no GET list API at a static URL, so they get no tiers and their
-- cards render Coming soon. The capability ids are the enforcement source;
-- keep them in step with PROVIDER_TIERS in capabilities.ts —
-- tests/unit/provider-tiers.test.ts pins the parity.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list upcoming events on your calendar.","capabilities":["googlecalendar.events.read"]}]'::jsonb
WHERE provider = 'google-calendar';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search the files in your Drive.","capabilities":["googledrive.files.read"]}]'::jsonb
WHERE provider = 'google-drive';
