# Generated inventory

<!-- DO NOT EDIT. Emitted by `scripts/tech-spec-inventory.ts` (`make inventory`). -->

Facts about the tree, read at generation time. This file is the whole of the
inventory; it does not restate prose from any authored spec.

Generated from the working tree. The output contains nothing environment-
dependent, so `inventory:check` behaves the same on a laptop and in CI.

## Stack

| Package | Version |
| --- | --- |
| `next` | 16.4.3 |
| `react` | 19.3.0 |
| `drizzle-orm` | 0.45.4 |
| `drizzle-kit` | 0.31.11 |
| `postgres` | ^3.4.9 |
| `pg` | absent |
| `@clerk/nextjs` | 7.9.21 |
| `@tiptap/react` | ^3.32.1 |
| `tailwindcss` | ^4.3.3 |
| `zod` | ^4.6.7 |
| `@vercel/blob` | ^2.8.2 |
| `eve` | ^0.76.3 |
| `vitest` | ^5.0.5 |
| `@playwright/test` | ^1.64.1 |

Migrations: 91 files, highest `0264_sticky_richard_fisk`.

## Tests

430 `.test.ts` and 43 `.spec.ts` files (unit: 251, integration: 179, e2e: 43).
## Domains

22 folders; 17 own tables.

| Domain | Tables |
| --- | ---: |
| `actions` | 7 |
| `agents` | 24 |
| `applications` | 3 |
| `audit` | 7 |
| `calendar` | 6 |
| `capture` | 2 |
| `crm` | 6 |
| `daybook` | 1 |
| `focus` | 1 |
| `gamification` | 4 |
| `identity` | 18 |
| `integrations` | 7 |
| `knowledge` | 46 |
| `opportunities` | 5 |
| `skills` | 1 |
| `spending` | 4 |
| `work` | 10 |

No tables: `conversations`, `home`, `import`, `notifications`, `supervisor`.

## Tables

| Domain | Table | State |
| --- | --- | --- |
| `actions` | `action_policies` | versioned |
| `actions` | `execution_settings` | versioned |
| `actions` | `action_proposals` | versioned |
| `actions` | `action_revisions` | append-only |
| `actions` | `action_reviews` | append-only |
| `actions` | `action_attempts` | append-only |
| `actions` | `provider_observations` | append-only |
| `agents` | `agent_profile_revisions` | append-only |
| `agents` | `runtime_executions` | versioned |
| `agents` | `runtime_signals` | atomic-counter + app-cas + trigger-immutable |
| `agents` | `tool_invocations` | trigger-immutable + app-cas |
| `agents` | `agent_profiles` | versioned |
| `agents` | `agent_principals` | versioned |
| `agents` | `agent_delegation_grants` | versioned (+ trigger-immutable) |
| `agents` | `agent_authorization_decisions` | append-only |
| `agents` | `threads` | versioned |
| `agents` | `messages` | append-only |
| `agents` | `thread_checkpoints` | append-only |
| `agents` | `agent_runs` | versioned (+ trigger-immutable) |
| `agents` | `agent_steps` | append-only |
| `agents` | `tool_calls` | append-only |
| `agents` | `agent_questions` | versioned |
| `agents` | `run_events` | append-only |
| `agents` | `run_reviews` | versioned |
| `agents` | `run_artifacts` | append-only |
| `agents` | `context_manifests` | append-only |
| `agents` | `context_manifest_items` | append-only |
| `agents` | `memory_items` | versioned |
| `agents` | `memory_revisions` | append-only |
| `agents` | `memory_reviews` | append-only |
| `agents` | `onboarding_sessions` | versioned |
| `applications` | `application_snapshots` | append-only |
| `applications` | `application_preparations` | versioned |
| `applications` | `application_materials` | versioned |
| `audit` | `request_receipts` | append-only |
| `audit` | `audit_events` | append-only |
| `audit` | `outbox_events` | append-only |
| `audit` | `webhook_inbox` | append-only |
| `audit` | `blob_objects` | versioned |
| `audit` | `jobs` | versioned |
| `audit` | `job_attempts` | append-only |
| `calendar` | `calendars` | versioned |
| `calendar` | `events` | versioned |
| `calendar` | `event_attendees` | append-only |
| `calendar` | `event_links` | append-only |
| `calendar` | `scheduler_preferences` | versioned |
| `calendar` | `schedule_proposals` | versioned |
| `capture` | `captures` | versioned |
| `capture` | `capture_proposals` | versioned |
| `crm` | `companies` | versioned |
| `crm` | `contacts` | versioned |
| `crm` | `contact_companies` | append-only |
| `crm` | `contact_observations` | versioned |
| `crm` | `correspondence` | versioned |
| `crm` | `follow_ups` | versioned |
| `daybook` | `day_artifact_pins` | append-only |
| `focus` | `focus_sessions` | versioned |
| `gamification` | `reward_definitions` | versioned |
| `gamification` | `reward_ledger` | append-only |
| `gamification` | `user_progress` | versioned |
| `gamification` | `daily_snapshots` | append-only |
| `identity` | `memberships` | versioned |
| `identity` | `role_definitions` | versioned |
| `identity` | `role_definition_revisions` | append-only |
| `identity` | `resource_grants` | versioned |
| `identity` | `membership_role_assignments` | versioned |
| `identity` | `user_preferences` | versioned |
| `identity` | `api_clients` | versioned |
| `identity` | `api_client_usage` | append-only |
| `identity` | `people` | versioned |
| `identity` | `organizations` | versioned |
| `identity` | `party_employment` | versioned |
| `identity` | `party_relationships` | versioned |
| `identity` | `contact_points` | versioned |
| `identity` | `external_identities` | append-only |
| `identity` | `account_person_links` | append-only |
| `identity` | `invitations` | versioned |
| `identity` | `users` | versioned |
| `identity` | `workspaces` | versioned |
| `integrations` | `connection_attempts` | append-only |
| `integrations` | `integration_catalog` | append-only |
| `integrations` | `external_accounts` | versioned |
| `integrations` | `sync_cursors` | versioned |
| `integrations` | `triggers` | versioned |
| `integrations` | `provider_quota_buckets` | atomic-counter |
| `integrations` | `provider_usage_ledger` | append-only |
| `knowledge` | `artifacts` | versioned |
| `knowledge` | `artifact_versions` | append-only |
| `knowledge` | `working_drafts` | versioned |
| `knowledge` | `recovery_copies` | append-only |
| `knowledge` | `files` | versioned |
| `knowledge` | `documents` | versioned |
| `knowledge` | `document_folders` | versioned |
| `knowledge` | `document_folder_events` | append-only |
| `knowledge` | `document_export_manifests` | versioned |
| `knowledge` | `document_export_packets` | append-only |
| `knowledge` | `document_tags` | append-only |
| `knowledge` | `document_export_manifest_items` | append-only |
| `knowledge` | `document_extractions` | append-only |
| `knowledge` | `document_extraction_attempts` | append-only |
| `knowledge` | `document_decisions` | append-only |
| `knowledge` | `sources` | versioned |
| `knowledge` | `youtube_transcripts` | append-only |
| `knowledge` | `claims` | versioned |
| `knowledge` | `artifact_links` | append-only |
| `knowledge` | `claim_evidence` | append-only |
| `knowledge` | `embeddings` | append-only |
| `knowledge` | `notebooks` | versioned |
| `knowledge` | `notebook_sources` | append-only |
| `knowledge` | `notebook_questions` | versioned |
| `knowledge` | `notebook_automations` | versioned |
| `knowledge` | `notebook_memories` | versioned |
| `knowledge` | `notebook_accounts` | append-only |
| `knowledge` | `concepts` | versioned |
| `knowledge` | `canvases` | versioned |
| `knowledge` | `canvas_versions` | append-only |
| `knowledge` | `document_parties` | versioned |
| `knowledge` | `field_proposals` | versioned |
| `knowledge` | `reviewed_assertions` | versioned |
| `knowledge` | `document_obligations` | versioned |
| `knowledge` | `zettel_proposals` | versioned |
| `knowledge` | `document_enrichment` | lease |
| `knowledge` | `wiki_pages` | versioned |
| `knowledge` | `document_reading_events` | append-only |
| `knowledge` | `document_reading_state` | versioned |
| `knowledge` | `document_classification_proposals` | versioned |
| `knowledge` | `document_rename_events` | append-only |
| `knowledge` | `note_comments` | versioned |
| `knowledge` | `taxonomy_nodes` | versioned |
| `knowledge` | `statement_imports` | versioned |
| `knowledge` | `statement_transactions` | append-only |
| `knowledge` | `transaction_category_rules` | versioned |
| `opportunities` | `opportunities` | versioned |
| `opportunities` | `opportunity_stage_history` | append-only |
| `opportunities` | `opportunity_extensions` | versioned |
| `opportunities` | `opportunity_links` | append-only |
| `opportunities` | `opportunity_deadlines` | versioned |
| `skills` | `skills` | versioned |
| `spending` | `model_rate_cards` | versioned |
| `spending` | `spending_policies` | versioned |
| `spending` | `spending_reservations` | versioned |
| `spending` | `spend_settlements` | append-only |
| `work` | `spaces` | versioned |
| `work` | `projects` | versioned |
| `work` | `recurrence_templates` | versioned |
| `work` | `tasks` | versioned |
| `work` | `task_dependencies` | versioned |
| `work` | `task_links` | append-only |
| `work` | `boards` | versioned |
| `work` | `board_columns` | versioned |
| `work` | `saved_views` | versioned |
| `work` | `briefing_seeds` | versioned |

Totals: 90 versioned, 58 append-only, 4 versionless but guarded (each declared with its guard and its file in `scripts/lib/row-state.ts`).

## Route handlers

- `/api/integrations/callback`
- `/api/internal/cron`
- `/api/internal/outbox`
- `/api/mcp`
- `/api/v1/captures`
- `/api/v1/captures/[captureId]/file`
- `/api/v1/captures/file`
- `/api/v1/documents/[documentId]/extract`
- `/api/v1/documents/[documentId]/file`
- `/api/v1/documents/[documentId]/preview`
- `/api/v1/documents/[documentId]/statement`
- `/api/v1/documents/[documentId]/text`
- `/api/v1/documents/readiness`
- `/api/v1/dossiers/[[...path]]`
- `/api/v1/drafts`
- `/api/v1/drafts/[artifactId]/[decision]`
- `/api/v1/exports/manifests/[manifestId]/packet`
- `/api/v1/exports/packets/[packetId]`
- `/api/v1/files`
- `/api/v1/focus/live`
- `/api/v1/projects`
- `/api/v1/projects/[projectId]/generate`
- `/api/v1/records/search`
- `/api/v1/research/company`
- `/api/v1/runs`
- `/api/v1/runs/[runId]`
- `/api/v1/runs/[runId]/cancel`
- `/api/v1/runs/[runId]/feedback`
- `/api/v1/runs/[runId]/messages`
- `/api/v1/runs/[runId]/retry`
- `/api/v1/runs/[runId]/stream`
- `/api/v1/search`

## Provider tools

29 tools.

- `airtable_list_records`
- `asana_list_tasks`
- `calendly_list_events`
- `canva_list_designs`
- `discord_list_channels`
- `github_read_issue`
- `github_search`
- `gmail_read_thread`
- `gmail_search`
- `gmail_send`
- `googlecalendar_list_events`
- `googledocs_search_files`
- `googledrive_search_files`
- `googlesheets_list_spreadsheets`
- `hubspot_list_contacts`
- `instagram_get_profile`
- `instagram_list_media`
- `linear_read_issue`
- `linear_search_issues`
- `linkedin_get_profile`
- `notion_read_page`
- `notion_search`
- `slack_list_channels`
- `slack_read_channel`
- `stripe_list_payments`
- `trello_list_cards`
- `writer_draft_follow_up`
- `writer_draft_reply`
- `zoom_list_meetings`

## Bundled skills

- weekly-review (Weekly review)
- research-brief (Research brief)
- linear-issue-draft (Linear issue draft)
- design-brief (Design brief)
- meeting-notes (Meeting notes)
- calendar-conflicts (Calendar conflicts)

## Outbox

Emitted topics: 24. Registered handlers: 10. Declared audit-only: 0.

Topics with no handler and no declaration (a defect if non-empty):

- `agent_principal.registered`
- `agent_principal.status_changed`
- `delegation_grant.issued`
- `delegation_grant.revoked`
- `grant.created`
- `grant.revoked`
- `note.snapshot`
- `research.company.completed`
- `research.profile.completed`
- `role.archived`
- `role.assigned`
- `role.defined`
- `role.revised`
- `role.unassigned`

Declared audit-only (observation events; no consumer by design):

- none
