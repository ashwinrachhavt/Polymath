-- 0246: tier offers for Google Docs and Sheets. Both list through Drive's
-- files endpoint filtered by mimeType, which the generic read can express —
-- the 0230 comment claiming otherwise was wrong. Capability ids are the
-- enforcement source; keep in step with PROVIDER_TIERS (provider-tiers.test.ts).
--
-- The inserts backfill the catalog rows themselves: a database seeded before
-- 0223 has no google-calendar, google-docs or google-sheets row at all, so the
-- tier updates below would silently match nothing against the missing rows.
-- Re-applying is a no-op where the row exists.
INSERT INTO integration_catalog (provider, display_name, capabilities, risk_by_capability, requires_approval)
VALUES
  ('google-calendar', 'Google Calendar',
   '["read_events", "write_events"]'::jsonb,
   '{"read_events": "read", "write_events": "external_write"}'::jsonb, true),
  ('google-drive', 'Google Drive',
   '["read_files", "upload_files"]'::jsonb,
   '{"read_files": "read", "upload_files": "external_write"}'::jsonb, true),
  ('google-docs', 'Google Docs',
   '["read_documents", "write_documents"]'::jsonb,
   '{"read_documents": "read", "write_documents": "external_write"}'::jsonb, true),
  ('google-sheets', 'Google Sheets',
   '["read_sheets", "write_sheets"]'::jsonb,
   '{"read_sheets": "read", "write_sheets": "external_write"}'::jsonb, true)
ON CONFLICT (provider) DO NOTHING;

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list upcoming events on your calendar.","capabilities":["googlecalendar.events.read"]}]'::jsonb
WHERE provider = 'google-calendar';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can search your Google Docs.","capabilities":["googledocs.documents.read"]}]'::jsonb
WHERE provider = 'google-docs';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list your Google Sheets spreadsheets.","capabilities":["googlesheets.spreadsheets.read"]}]'::jsonb
WHERE provider = 'google-sheets';
