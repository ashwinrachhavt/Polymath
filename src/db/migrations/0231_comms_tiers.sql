-- 0231: tier offers for the comms and meetings cluster (discord, zoom, calendly).
-- Notion is deliberately absent: its read is POST-shaped (/v1/search) and the
-- generic transport is GET-only, so its catalog row keeps empty tiers and
-- renders "Coming soon". The capability ids are the enforcement source; keep
-- them in step with PROVIDER_TIERS in capabilities.ts.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the Discord servers your connection can see.","capabilities":["discord.guilds.read"]}]'::jsonb
WHERE provider = 'discord';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list your scheduled Zoom meetings.","capabilities":["zoom.meetings.read"]}]'::jsonb
WHERE provider = 'zoom';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list your scheduled Calendly events.","capabilities":["calendly.events.read"]}]'::jsonb
WHERE provider = 'calendly';
