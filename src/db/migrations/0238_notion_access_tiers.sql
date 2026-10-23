-- 0238: Notion's read tools ship (notion_search, notion_read_page through the
-- constant-body POST seam), so its catalog row gets the tier the connect
-- screen offers. Mirrors PROVIDER_TIERS.notion in capabilities.ts - until
-- this runs, the card stays honest "Coming soon".
UPDATE "integration_catalog"
SET "access_tiers" = '[{"id":"read_only","label":"Read only","description":"Agents can search and read the pages and databases you share with the connection.","capabilities":["notion.read","notion.page.read"]}]'::jsonb
WHERE provider = 'notion';
