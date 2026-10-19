-- D09: the static connector catalog. Capabilities name what the provider can
-- do; risk_by_capability gates each on read | prepare | external_write |
-- sensitive_write. Rows are keyed by provider; re-applying is a no-op.
insert into integration_catalog (provider, display_name, capabilities, risk_by_capability, requires_approval)
values
  ('gmail', 'Gmail',
   '["read_messages", "prepare_drafts", "send_mail"]'::jsonb,
   '{"read_messages": "read", "prepare_drafts": "prepare", "send_mail": "external_write"}'::jsonb, true),
  ('google-calendar', 'Google Calendar',
   '["read_events", "write_events"]'::jsonb,
   '{"read_events": "read", "write_events": "external_write"}'::jsonb, true),
  ('notion', 'Notion',
   '["read_pages", "write_pages"]'::jsonb,
   '{"read_pages": "read", "write_pages": "external_write"}'::jsonb, true),
  ('github', 'GitHub',
   '["read_repositories", "write_comments"]'::jsonb,
   '{"read_repositories": "read", "write_comments": "external_write"}'::jsonb, true),
  ('slack', 'Slack',
   '["read_channels", "post_messages"]'::jsonb,
   '{"read_channels": "read", "post_messages": "external_write"}'::jsonb, true),
  ('linear', 'Linear',
   '["read_issues", "write_issues"]'::jsonb,
   '{"read_issues": "read", "write_issues": "external_write"}'::jsonb, true)
on conflict (provider) do nothing;
