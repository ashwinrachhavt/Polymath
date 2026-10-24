-- 0239: LinkedIn and Instagram join the catalog with read-only tiers. The
-- slices (linkedin_get_profile, instagram_get_profile, instagram_list_media)
-- are live in code, but a card only leaves "Coming soon" once this row exists
-- AND the deployment carries a Composio auth config for the provider - until
-- then the Connect button fails honestly with a not-configured message.
-- Mirrors PROVIDER_TIERS.linkedin / PROVIDER_TIERS.instagram in capabilities.ts.
INSERT INTO "integration_catalog" ("provider", "display_name", "capabilities", "risk_by_capability", "requires_approval")
VALUES
  ('linkedin', 'LinkedIn',
   '["read_profile"]'::jsonb,
   '{"read_profile": "read"}'::jsonb, true),
  ('instagram', 'Instagram',
   '["read_profile", "read_media"]'::jsonb,
   '{"read_profile": "read", "read_media": "read"}'::jsonb, true)
ON CONFLICT ("provider") DO NOTHING;

UPDATE "integration_catalog"
SET "access_tiers" = '[{"id":"read_only","label":"Read only","description":"Agents can read your LinkedIn profile name, headline and photo.","capabilities":["linkedin.profile.read"]}]'::jsonb
WHERE provider = 'linkedin';

UPDATE "integration_catalog"
SET "access_tiers" = '[{"id":"read_only","label":"Read only","description":"Agents can read your Instagram profile and recent media. Needs a Business or Creator account.","capabilities":["instagram.profile.read","instagram.media.read"]}]'::jsonb
WHERE provider = 'instagram';
