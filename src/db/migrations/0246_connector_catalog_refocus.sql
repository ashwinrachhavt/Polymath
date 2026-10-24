-- 0246: refocus the connector catalog on the providers this deployment
-- actually points agents at. Providers dropped here lose their catalog row;
-- any external_accounts rows that reference them are revoked first so the
-- cards' history stays truthful. The added providers seed as empty
-- access_tiers rows: they render "Coming soon" until their agent reads ship
-- and a Composio auth config exists, the same state 0031 gave Figma.
DELETE FROM "external_accounts"
WHERE "provider" IN (
  'asana', 'calendly', 'dropbox', 'figma', 'google-calendar',
  'instagram', 'jira', 'salesforce', 'stripe', 'trello', 'zoom'
);

DELETE FROM "integration_catalog"
WHERE "provider" IN (
  'asana', 'calendly', 'dropbox', 'figma', 'google-calendar',
  'instagram', 'jira', 'salesforce', 'stripe', 'trello', 'zoom'
);

INSERT INTO "integration_catalog" ("provider", "display_name", "capabilities", "risk_by_capability", "requires_approval")
VALUES
  ('perplexity', 'Perplexity AI',   '[]'::jsonb, '{}'::jsonb, true),
  ('supabase',   'Supabase',        '[]'::jsonb, '{}'::jsonb, true),
  ('serpapi',    'SerpAPI',         '[]'::jsonb, '{}'::jsonb, true),
  ('firecrawl',  'Firecrawl',       '[]'::jsonb, '{}'::jsonb, true),
  ('youtube',    'YouTube',         '[]'::jsonb, '{}'::jsonb, true),
  ('reddit',     'Reddit',          '[]'::jsonb, '{}'::jsonb, true),
  ('sentry',     'Sentry',          '[]'::jsonb, '{}'::jsonb, true),
  ('hackernews', 'Hacker News',     '[]'::jsonb, '{}'::jsonb, true),
  ('docusign',   'DocuSign',        '[]'::jsonb, '{}'::jsonb, true),
  ('apollo',     'Apollo',          '[]'::jsonb, '{}'::jsonb, true),
  ('neon',       'Neon',            '[]'::jsonb, '{}'::jsonb, true),
  ('browserbase','Browserbase',    '[]'::jsonb, '{}'::jsonb, true),
  ('attio',      'Attio',           '[]'::jsonb, '{}'::jsonb, true),
  ('fireflies',  'Fireflies',       '[]'::jsonb, '{}'::jsonb, true)
ON CONFLICT ("provider") DO NOTHING;
