# Connectors — trust & control design

**Date:** 2026-10-21
**Status:** Approved design, pending implementation plan
**Supersedes:** nothing; narrows the connectors slice of
`docs/axiom-nextjs-neon-plan.md` §10–§11 and the connector catalog expansion in
migration `0223_connector_catalog_expansion.sql`.

## Problem

The Connectors page (`src/app/(workspace)/command-center/integrations/`)
does not do its job. Three failures:

1. **The state machine lies.** A card can read "Connecting" while also showing
   "Never connected" and offering both Disconnect and Connect. Error and
   expired accounts render as generic "Available". The person cannot tell
   what is actually connected or broken.
2. **Access control is invisible jargon.** The card body renders capability
   names with internal risk labels — "read messages (read) · prepare drafts
   (prepare) · send mail (external_write)". A person cannot answer "what are
   my agents allowed to do with this connection?"
3. **The catalog overpromises.** Migration `0223` seeds 22 providers into
   `integration_catalog`, so the UI shows 22 connectable cards, but the
   gateway can only route 9 tools across 4 providers
   (`src/domains/integrations/capabilities.ts`). Connecting the other 18
   yields a credential the product cannot use.

Enforcement today is two binary switches per account
(`external_accounts.allow_read` / `allow_write`) plus the workspace-level
profile tool list. There is no per-connector grant that a person can read and
choose.

## Decisions (agreed 2026-10-21)

- **Primary job of Connectors is trust and control**: a person sees at a
  glance what is connected, what agents may do with each connection, and can
  fix what is broken. Catalog breadth is the second job.
- **Agent access is per-connector tiers**, not per-action toggles. One choice
  per connection, plain-language labels. Scales to a wide catalog without a
  wall of switches.
- **Catalog breadth is curated in-repo.** No live Composio app/tool listing.
  Breadth grows by reviewed catalog migrations. Live search, starter packs,
  and per-action overrides are roadmap.
- **Writes stay proposal-only.** Nothing in this change creates a direct
  external write path. Only `read` and `external_write` capabilities ship;
  `external_write` still flows through action proposals.

## 1. Data model

One forward-only migration plus follow-ups.

### `integration_catalog.access_tiers` (jsonb)

Ordered list of tiers per provider. Each tier:

```jsonc
{
  "id": "read_draft",
  "label": "Read + draft",
  "description": "Agent can search and read mail, and prepare drafts for your approval",
  "capabilities": ["gmail.search", "gmail.read", "gmail.thread.read", "gmail.prepare_draft"]
}
```

- Tier capability lists are the **enforcement source**, not display metadata.
  The existing `capabilities` / `risk_by_capability` columns remain display
  metadata for the connect screen (and keep `risk_by_capability`'s documented
  "nothing gates on it" status).
- Tiers are defined once per provider in code-seeded migrations, same pattern
  as `0031` / `0041` / `0223`. Every one of the 22 seeded providers must have
  at least a read-only tier whose capabilities all exist in
  `capabilities.ts`.

### `external_accounts.access_tier` (text)

- Default: the provider's lowest tier.
- The binary `allow_read` / `allow_write` columns lose their enforcement role
  in this change. The gateway stops consulting them. A later migration drops
  them once nothing reads them (recorded as a follow-up; not in this change).

## 2. Catalog ↔ gateway bridge

The real unlock: make the catalog honest and routable.

- `src/domains/integrations/capabilities.ts` grows from 9 tools to the full
  tool set the curated catalog claims. Every provider in migration `0223`
  gets at least its read-tier tools defined in `PROVIDER_TOOLS`,
  `TOOL_SCHEMAS`, and `TOOL_DESCRIPTIONS` (Google Drive/Docs/Sheets, Google
  Calendar, Discord, Zoom, Calendly, Jira, Asana, Trello, Airtable, Figma,
  Canva, Dropbox, HubSpot, Salesforce, Stripe, plus the existing Gmail,
  Slack, GitHub, Linear, Notion, Vercel). Each is verified against the
  Composio v3 execute proxy — a read tool that cannot be routed does not
  ship.
- Existing known gaps stay documented in `capabilities.ts` (Linear
  POST-shaped GraphQL read, unwired GitHub/Slack writes); a tier may not
  include a capability the transport cannot express.
- **Gateway enforcement change**
  (`src/domains/agents/gateway.ts`): instead of reading
  `allowRead`/`allowWrite` from the resolved account, the gateway resolves
  the account's tier and checks the requested tool against that tier's
  capability list. A tool above the connection's tier returns
  `permission_denied` with copy pointing at the tier control on Connectors.
- Delegation attenuation (`src/domains/agents/delegation.ts`
  `assertAttenuation`) is unchanged mechanically: grants compare
  tier-derived capability sets, subset check, depth cap 3.
- Profile-level `allowedTools` / `policySnapshot` continue to gate above the
  tier: a tool must pass both the run's policy snapshot and the connection's
  tier.
- Stripe remains `sensitive_write`, proposal-only, highest tier.

## 3. UI redesign

Per connector card, one honest state machine:

`needs_config` → `available` → `connecting` → `connected` ⇄ `action_needed`

- **needs_config** — provider requires env (`COMPOSIO_AUTH_CONFIG_<PROVIDER>`)
  that is missing. Card says what an operator must set; no Connect button.
- **available** — one primary "Connect" button. Registration merges into the
  connect flow: the alias is prompted inline before the OAuth redirect.
  Removes the "Register a {provider} account below" misdirection entirely.
- **connecting** — single state with the pending alias and a "Finish
  connecting" affordance. No Disconnect/Connect contradiction, no "Never
  connected" beside a spinner.
- **connected** — account alias, last healthy time, and the tier as one
  labeled control: "Agent access: Read + draft ▾", opening a picker of that
  provider's tiers with plain-language descriptions. Capability/risk jargon
  (`read`, `prepare`, `external_write`) appears only inside the tier picker,
  where it carries meaning. Multiple accounts list with the write-default
  badge as today.
- **action_needed** (error / expired) — plain-language reason from
  `lastError`, one Reconnect button.

Filter tabs keep All / Connected / Available. Category groups extend to the
full catalog (Communication, Planning, Knowledge, Developer, Finance, Sales,
Design, Storage…). Server page, client cards, and server actions stay in
their current files; `setAccountPermissionAction` is replaced by a
`setAccountAccessTierAction`.

Copy follows `agents/product.md` voice: the card says what the person
controls, active voice, no apologising, empty states are invitations.

## 4. Out of scope (roadmap)

- Live Composio app/tool discovery.
- Per-action toggles under a tier (advanced overrides).
- Starter packs per persona (software engineer, accountant, …).
- Dropping `allow_read` / `allow_write` columns (follow-up migration).
- Triggers and quota rows (`triggers`, `provider_quota_buckets`,
  `provider_usage_ledger`) — unchanged.

## 5. Tests

- **Tier enforcement invariant** at the gateway, against real Postgres
  (same suite as tenancy/idempotency): a tool above the connection's tier is
  denied; a tool within it is allowed; a tool passing the tier but absent
  from the run's policy snapshot is still denied.
- **Attenuation** test updated for tier-derived capability sets — subset
  rule still holds across delegation depth.
- **Catalog honesty** check: every provider row in the seeded catalog has ≥1
  tier whose capabilities all resolve in `capabilities.ts` (fails the build
  of the migration if not).
- **Playwright journey**: connect → set tier to "Read only" → agent send
  attempt → denied with pointer to tier control; raise tier → send attempt →
  proposal path.
- Card state machine unit coverage: each of the five states from the account
  rows the page already renders.

## Acceptance criteria

1. Opening Connectors answers three questions at a glance: what is
   connected, what may agents do with it, what needs fixing.
2. No card shows contradictory state (no Connecting + "Never connected" +
   dual buttons).
3. Every connectable provider in the catalog is actually routable by the
   gateway for its lowest tier.
4. Tier change takes effect on the next agent call without re-connecting.
5. `make check` passes; the tier-enforcement invariant test runs against
   real Postgres.
