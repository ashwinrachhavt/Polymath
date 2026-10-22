-- 0232: tier offers for the work-management cluster (asana, trello, airtable).
-- Jira's host is per-site and nothing resolves it statically yet, so it gets
-- no tiers and its card renders Coming soon. The capability ids are the
-- enforcement source; keep them in step with PROVIDER_TIERS in capabilities.ts.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the tasks assigned to you in Asana.","capabilities":["asana.tasks.read"]}]'::jsonb
WHERE provider = 'asana';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the Trello cards on your boards.","capabilities":["trello.cards.read"]}]'::jsonb
WHERE provider = 'trello';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the bases in your Airtable workspace.","capabilities":["airtable.bases.read"]}]'::jsonb
WHERE provider = 'airtable';
