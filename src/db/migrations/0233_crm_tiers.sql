-- 0233: tier offers for the design, CRM and finance cluster (canva, hubspot,
-- stripe). Figma (files list needs a project id), Dropbox (list_folder is
-- POST-shaped) and Salesforce (per-org host, unresolvable statically) have no
-- GET-expressible list and stay absent from the migration, so their catalog
-- rows keep empty tiers and render "Coming soon". The capability ids are the
-- enforcement source; keep them in step with PROVIDER_TIERS in
-- capabilities.ts.
UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list your Canva designs.","capabilities":["canva.designs.read"]}]'::jsonb
WHERE provider = 'canva';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list the contacts in your HubSpot CRM.","capabilities":["hubspot.contacts.read"]}]'::jsonb
WHERE provider = 'hubspot';

UPDATE integration_catalog SET access_tiers = '[{"id":"read_only","label":"Read only","description":"Agents can list payments and charges. Read-only; charges are never agent-proposed in this tier.","capabilities":["stripe.payments.read"]}]'::jsonb
WHERE provider = 'stripe';
