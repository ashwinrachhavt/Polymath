-- The connector catalog, widened to every provider this deployment can actually
-- authorize. Each pair of entries names what an agent may read and what it may
-- only ever propose; the write side is always `external_write`, so nothing here
-- grants a direct external effect.
--
-- Every provider below was verified against the live Composio account on
-- 2026-10-21: an auth config existed or was created, and a hosted connect link
-- minted successfully. Providers that cannot mint (Vercel has no Composio-managed
-- credentials) are deliberately absent rather than shown and failing.
--
-- Re-applying is a no-op thanks to the provider key.
insert into integration_catalog (provider, display_name, capabilities, risk_by_capability, requires_approval)
values
  ('gmail', 'Gmail',
   '["read_messages", "prepare_drafts", "send_mail"]'::jsonb,
   '{"read_messages": "read", "prepare_drafts": "prepare", "send_mail": "external_write"}'::jsonb, true),
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
   '{"read_sheets": "read", "write_sheets": "external_write"}'::jsonb, true),
  ('slack', 'Slack',
   '["read_channels", "post_messages"]'::jsonb,
   '{"read_channels": "read", "post_messages": "external_write"}'::jsonb, true),
  ('discord', 'Discord',
   '["read_messages", "post_messages"]'::jsonb,
   '{"read_messages": "read", "post_messages": "external_write"}'::jsonb, true),
  ('zoom', 'Zoom',
   '["read_meetings", "create_meetings"]'::jsonb,
   '{"read_meetings": "read", "create_meetings": "external_write"}'::jsonb, true),
  ('calendly', 'Calendly',
   '["read_events", "create_links"]'::jsonb,
   '{"read_events": "read", "create_links": "external_write"}'::jsonb, true),
  ('notion', 'Notion',
   '["read_pages", "write_pages"]'::jsonb,
   '{"read_pages": "read", "write_pages": "external_write"}'::jsonb, true),
  ('github', 'GitHub',
   '["read_repositories", "write_comments"]'::jsonb,
   '{"read_repositories": "read", "write_comments": "external_write"}'::jsonb, true),
  ('linear', 'Linear',
   '["read_issues", "write_issues"]'::jsonb,
   '{"read_issues": "read", "write_issues": "external_write"}'::jsonb, true),
  ('jira', 'Jira',
   '["read_issues", "write_issues"]'::jsonb,
   '{"read_issues": "read", "write_issues": "external_write"}'::jsonb, true),
  ('asana', 'Asana',
   '["read_tasks", "write_tasks"]'::jsonb,
   '{"read_tasks": "read", "write_tasks": "external_write"}'::jsonb, true),
  ('trello', 'Trello',
   '["read_cards", "write_cards"]'::jsonb,
   '{"read_cards": "read", "write_cards": "external_write"}'::jsonb, true),
  ('airtable', 'Airtable',
   '["read_records", "write_records"]'::jsonb,
   '{"read_records": "read", "write_records": "external_write"}'::jsonb, true),
  ('figma', 'Figma',
   '["read_files", "write_comments"]'::jsonb,
   '{"read_files": "read", "write_comments": "external_write"}'::jsonb, true),
  ('canva', 'Canva',
   '["read_designs", "create_designs"]'::jsonb,
   '{"read_designs": "read", "create_designs": "external_write"}'::jsonb, true),
  ('dropbox', 'Dropbox',
   '["read_files", "write_files"]'::jsonb,
   '{"read_files": "read", "write_files": "external_write"}'::jsonb, true),
  ('hubspot', 'HubSpot',
   '["read_contacts", "write_contacts"]'::jsonb,
   '{"read_contacts": "read", "write_contacts": "external_write"}'::jsonb, true),
  ('salesforce', 'Salesforce',
   '["read_records", "write_records"]'::jsonb,
   '{"read_records": "read", "write_records": "external_write"}'::jsonb, true),
  ('stripe', 'Stripe',
   '["read_payments", "create_charges"]'::jsonb,
   '{"read_payments": "read", "create_charges": "sensitive_write"}'::jsonb, true)
on conflict (provider) do update set
  display_name = excluded.display_name,
  capabilities = excluded.capabilities,
  risk_by_capability = excluded.risk_by_capability,
  requires_approval = excluded.requires_approval;
