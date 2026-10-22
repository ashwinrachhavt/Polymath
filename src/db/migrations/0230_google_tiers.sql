-- 0230: tier offers for the Google cluster A (calendar, drive, docs, sheets).
-- The capability ids are the enforcement source; keep them in step with
-- PROVIDER_TIERS in capabilities.ts — tests/unit/provider-tiers.test.ts pins
-- the parity.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list upcoming events on your calendar.","capabilities":["googlecalendar.events.read"]}]'::jsonb
WHERE provider = 'google-calendar';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search the files in your Drive.","capabilities":["googledrive.files.read"]}]'::jsonb
WHERE provider = 'google-drive';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the documents in your Google Docs.","capabilities":["googledocs.documents.read"]}]'::jsonb
WHERE provider = 'google-docs';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the spreadsheets in your Google Sheets.","capabilities":["googlesheets.sheets.read"]}]'::jsonb
WHERE provider = 'google-sheets';
