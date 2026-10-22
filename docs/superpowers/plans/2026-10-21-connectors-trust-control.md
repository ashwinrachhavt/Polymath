# Connectors Trust & Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-connector agent access tiers enforced at the gateway, an honest five-state connector card, and a progressive expansion of read tools across the 22-provider catalog.

**Architecture:** Access tiers are defined in code (`PROVIDER_TIERS` in `capabilities.ts`) and mirrored into `integration_catalog.access_tiers` jsonb by migration. The gateway replaces the binary `allow_read`/`allow_write` consult with a tier check. New provider read tools go through a generic registry-driven reader over the existing Composio transport, so each new provider is a registry entry plus schemas, not a bespoke module.

**Tech Stack:** Next.js 16 server actions, Drizzle, forward-only SQL migrations, Vitest (unit + real-Postgres integration), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-connectors-trust-control-design.md`

## Global Constraints

- Forward-only SQL migrations, never edited after running. Next number: `0229`.
- Every owned table row carries `workspace_id`; queries scope by `AuthContext`.
- Optimistic concurrency: account mutations take `expectedVersion`; stale writes throw `StaleWriteError`.
- Audit rows are written in the same transaction as the change (`recordAudit` with `tx`).
- Writes stay proposal-only: no new capability of kind other than `read`/`proposal`; `external_write` still flows through action proposals.
- Capability names appear in three vocabularies that must not drift (policy snapshot, eval risk table, MCP tool name) — `capabilities.ts` is the single map.
- Copy: sentence case, active voice, no apology, no exclamation marks; the card says what the person controls.
- Integration tests run against real Postgres via `TEST_DATABASE_URL` (`tests/helpers/test-workspace.ts`); CI must not skip them silently.
- Commands: `pnpm test` (vitest), `pnpm check` (lint + typecheck + test + build).
- No new dependencies.

## Review Focus

- **Stuck "connecting" attempt past its 15-minute TTL** — the card must show `action_needed` (start again), never an eternal spinner. Pinned by the state-machine unit test in Task 6.
- **Tier flipped mid-run** — the run's policy snapshot is frozen but the tier is read live; a call allowed at run start must be denied mid-run with copy pointing at the tier control, not the run. Pinned by Task 3's live-tier test.
- **Catalog drift** — a provider's seeded `access_tiers` jsonb referencing a capability that does not exist in `CAPABILITIES` must fail the honesty test, not deny-closed silently at runtime. Pinned by Task 2's invariant test.
- **Multiple accounts on one provider with different tiers** — an unaliased call into ambiguity must name the accounts and stay denied; it must not silently pick the permissive one. Pinned by Task 3.
- **Provider with zero tiers (not yet shipped)** must render "Coming soon" and must not mint a connect link. Pinned by Task 6 unit test + Task 5 action guard.

---

### Task 1: Migration 0229 — tier columns and first seed

**Files:**
- Create: `src/db/migrations/0229_access_tiers.sql`
- Test: `tests/integration/access-tiers.test.ts`

**Interfaces:**
- Produces: `integration_catalog.access_tiers` jsonb (array of `{id, label, description, capabilities[]}`), `external_accounts.access_tier text NULL`. Later tasks read both; `listConnectors` (Task 7) surfaces tiers to the UI.

- [ ] **Step 1: Write the migration**

```sql
-- 0229: per-connector agent access tiers. The capability lists are the
-- enforcement source; integration_catalog.access_tiers mirrors
-- PROVIDER_TIERS in capabilities.ts for the UI. Providers whose read tools
-- have not shipped keep empty tiers and render "Coming soon" — they are not
-- connectable until a slice adds their tools.
ALTER TABLE "integration_catalog"
  ADD COLUMN IF NOT EXISTS "access_tiers" jsonb NOT NULL DEFAULT '[]';

ALTER TABLE "external_accounts"
  ADD COLUMN IF NOT EXISTS "access_tier" text;

UPDATE external_accounts SET access_tier = 'read_only' WHERE access_tier IS NULL;
```

Plus one `UPDATE integration_catalog SET access_tiers = '…'::jsonb WHERE provider = 'gmail';` style seed for exactly these four providers (tier JSON must match Task 2's `PROVIDER_TIERS` verbatim):

- `gmail`: `[{"id":"read_only","label":"Read only","description":"Agents can search and read mail.","capabilities":["gmail.read","gmail.thread.read"]},{"id":"read_send","label":"Read + send proposals","description":"Agents can also draft send proposals for your approval.","capabilities":["gmail.read","gmail.thread.read","gmail.send"]}]`
- `github`: `[{"id":"read_only","label":"Read only","description":"Agents can search repositories and read issues.","capabilities":["github.read","github.issue.read"]}]`
- `slack`: `[{"id":"read_only","label":"Read only","description":"Agents can list channels and read messages.","capabilities":["slack.channels.read","slack.read"]}]`
- `linear`: `[{"id":"read_only","label":"Read only","description":"Agents can search and read issues.","capabilities":["linear.read","linear.issue.read"]}]`

- [ ] **Step 2: Write the failing integration test**

`tests/integration/access-tiers.test.ts`, following the `makeTestDb`/`seedWorkspace` pattern of `tests/integration/connector-permissions.test.ts`:

- `gmail catalog row has two tiers, lowest first` — select `access_tiers` for provider `gmail`, assert `tiers[0].id === "read_only"`, `tiers[1].capabilities` includes `"gmail.send"`.
- `providers without shipped tools have empty tiers` — assert `access_tiers` for `stripe`, `figma`, `notion` is `[]`.
- `existing accounts backfill to read_only` — insert an `external_accounts` row without `access_tier`, read back, assert `"read_only"`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/integration/access-tiers.test.ts`
Expected: FAIL (columns missing).

- [ ] **Step 4: Apply the migration and verify the test passes**

Apply migration `0229` the way the test harness does (confirm `makeTestDb` applies `src/db/migrations/*.sql` — if it does, the test run applies it; otherwise apply manually per `agents/reference.md`).

Run: `pnpm vitest run tests/integration/access-tiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/0229_access_tiers.sql tests/integration/access-tiers.test.ts
git commit -m "feat(connectors): access tier columns and first tier seed (0229)"
```

---

### Task 2: `PROVIDER_TIERS` and tier helpers in capabilities.ts

**Files:**
- Modify: `src/domains/integrations/capabilities.ts`
- Test: `tests/unit/provider-tiers.test.ts`

**Interfaces:**
- Consumes: existing `CAPABILITIES`, `PROVIDER_TOOLS`, `Provider`.
- Produces:
  - `export type AccessTier = { id: string; label: string; description: string; capabilities: Capability[] }`
  - `export const PROVIDER_TIERS: Record<Provider, AccessTier[]>` — gmail (read_only, read_send), github/slack/linear (read_only). Tier JSON must equal Task 1's seed verbatim.
  - `export function tierCapabilities(provider: Provider, tierId: string): Capability[]` — empty array for unknown tier id or provider with no tiers.
  - `export function tierAllows(provider: Provider, tierId: string, capability: Capability): boolean`
  - `export function lowestTierId(provider: Provider): string | null` — null when the provider has no tiers.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/provider-tiers.test.ts`:

- `every tier capability exists in CAPABILITIES` — iterate `PROVIDER_TIERS`, assert each capability is a key of `CAPABILITIES` (this is the catalog-drift invariant).
- `tier capabilities are ordered lowest-first and strictly extending` — for gmail, `tiers[1].capabilities` is a superset of `tiers[0].capabilities`.
- `tierAllows denies above the tier` — `tierAllows("gmail", "read_only", "gmail.send") === false`; `tierAllows("gmail", "read_send", "gmail.send") === true`; unknown tier id → false.
- `lowestTierId is null for a provider with no tiers` — after adding `notion: []` (empty array placeholder so the Record type covers the catalog), assert `lowestTierId("notion") === null`.
- `the gmail tier JSON matches migration 0229` — read `src/db/migrations/0229_access_tiers.sql` from disk, extract the gmail JSON literal, deep-equal it against `PROVIDER_TIERS.gmail` serialized with the same shape. (Cheap drift guard between code and seed.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/provider-tiers.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement the exports in capabilities.ts**

Add the type, `PROVIDER_TIERS`, and the three helpers below the existing `PROVIDER_TOOLS`. Keep the module's existing comment discipline: one short comment stating that tier capability lists are the enforcement source and `risk_by_capability` remains display metadata. `Record<Provider, AccessTier[]>` requires an entry per current `Provider` union — gmail, github, slack, linear all have entries, so no placeholder needed yet (notion joins the `Provider` union only in Task 9).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/provider-tiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/integrations/capabilities.ts tests/unit/provider-tiers.test.ts
git commit -m "feat(connectors): PROVIDER_TIERS as the enforcement source for agent access"
```

---

### Task 3: Gateway tier enforcement

**Files:**
- Modify: `src/domains/integrations/queries.ts` (`resolveConnectedAccount`)
- Modify: `src/domains/agents/gateway.ts` (the `call` function, step 2/2b)
- Test: `tests/integration/mcp-gateway.test.ts` (extend), `tests/integration/connected-account-resolution.test.ts` (update)

**Interfaces:**
- Consumes: `tierAllows`, `lowestTierId` from Task 2; `externalAccounts.accessTier` from Task 1.
- Produces: `resolveConnectedAccount(auth, provider, alias?, kind?)` — signature unchanged for callers, but the success return gains `accessTier: string`, and the `kind`-based `allowRead`/`allowWrite` denial is removed (callers keep passing `kind`; it still selects nothing — drop the parameter in the same change and update all callers: gateway `resolveAccount` passes it today, approved-effect executors intentionally omit it).

- [ ] **Step 1: Update/extend the failing tests**

In `tests/integration/connected-account-resolution.test.ts`: remove assertions on the binary-flag denial; add — an account with `accessTier: "read_only"` resolves with `accessTier: "read_only"`.

In `tests/integration/mcp-gateway.test.ts` (the existing real-Postgres gateway suite — follow its harness for run/identity setup):

- `a send above the tier is denied pointing at the tier control` — gmail account at `read_only`, run whose policy snapshot allows `gmail.send`, call `gmail_send` → outcome `ok: false`, `code: "permission_denied"`, message contains `Agent access` and `Connectors`.
- `a read within the tier passes the tier gate` — same account, `gmail_search` → proceeds (mock transport returns a result).
- `the tier is read live, not from a snapshot` — allow the send by setting `read_send`, get the proposal path (`awaiting_review`), then flip the account back to `read_only` and call again → denied. (Pins the mid-run tier flip.)
- `two active accounts with different tiers stay ambiguous` — two gmail accounts (`a` at read_only, `b` at read_send), unaliased `gmail_send` call → `code: "ambiguous_account"`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/integration/mcp-gateway.test.ts tests/integration/connected-account-resolution.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`queries.ts` `resolveConnectedAccount`: select `accessTier: externalAccounts.accessTier` instead of `allowRead`/`allowWrite`; delete the `if (kind)` flag block; on success return `{ ok: true, connectedAccountId, alias, accessTier: accessTier ?? "read_only" }`. Drop the now-unused `kind` parameter and update every caller (grep `resolveConnectedAccount` — the gateway's `resolveAccount`, and the approved-effect executor path which omits it).

`gateway.ts` `call`: after `resolveAccount` succeeds and before budget reservation, add the tier gate:

```ts
// 2b. The connection's tier, read live with the account. The snapshot above
// bounds what the run may want; the tier bounds what this connection grants.
if (!tierAllows(spec.provider, account.accessTier, capability)) {
  return {
    ok: false,
    status: 403,
    code: "permission_denied",
    message: `Agent access for "${account.alias}" does not include this. Raise the tier in Connectors.`,
  };
}
```

`resolveAccount`'s success type gains `accessTier: string` and threads it through.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/integration/mcp-gateway.test.ts tests/integration/connected-account-resolution.test.ts tests/unit/provider-tiers.test.ts`
Expected: PASS. Then `pnpm vitest run tests/integration/delegation-grants.test.ts` — attenuation tests must still pass unchanged (grants compare capability sets; tiers gate independently).

- [ ] **Step 5: Commit**

```bash
git add src/domains/integrations/queries.ts src/domains/agents/gateway.ts tests/integration/mcp-gateway.test.ts tests/integration/connected-account-resolution.test.ts
git commit -m "feat(gateway): enforce per-connection access tiers over binary flags"
```

---

### Task 4: Set-tier command and action

**Files:**
- Modify: `src/domains/integrations/commands.ts` (replace `setAccountPermissions`, `commands.ts:114`)
- Modify: `src/app/(workspace)/command-center/integrations/actions.ts` (replace `setAccountPermissionAction`, line 63)
- Test: `tests/integration/connector-permissions.test.ts` (rewrite), `tests/integration/connectors.test.ts` (update any references)

**Interfaces:**
- Consumes: `PROVIDER_TIERS`, `lowestTierId` (Task 2); `externalAccounts.accessTier` (Task 1).
- Produces: `setAccountAccessTier(auth, input: { accountId: string; expectedVersion: number; tierId: string })` → updated account row; throws `StaleWriteError` on version conflict, `ConflictError` when the tier id is not one of the provider's tiers or the provider has no tiers. Action: `setAccountAccessTierAction(input: { accountId: string; expectedVersion: number; tierId: string }): Promise<Result>`, member role (same authorization as the old permission action).

- [ ] **Step 1: Rewrite the failing integration test**

`tests/integration/connector-permissions.test.ts` becomes the tier command suite (keep the `makeTestDb` harness):

- `a fresh account sits at the lowest tier` — insert gmail account, read `accessTier === "read_only"`.
- `raising the tier persists and audits` — call `setAccountAccessTier` to `read_send`; assert row and an audit row with action `integration.account_tier_set` in the same transaction.
- `an unknown tier id is a ConflictError` — `setAccountAccessTier` with `"tier:ceiling"` throws.
- `a stale version throws StaleWriteError` — pass `expectedVersion: 1` after a prior write bumped it.
- `a provider with no tiers cannot be changed` — insert a `stripe` account, any `setAccountAccessTier` call throws `ConflictError`.
- `accounts stay tenant-scoped` — a second workspace's account id is not updatable (zero rows → `StaleWriteError`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/integration/connector-permissions.test.ts`
Expected: FAIL (function missing).

- [ ] **Step 3: Implement `setAccountAccessTier` and the action**

Command: resolve the account (workspace-scoped, `expectedVersion`), look up the account's provider in `PROVIDER_TIERS`, validate `tierId`, update `accessTier` + bump `version` + `updatedAt`/`updatedBy`, `recordAudit` with `action: "integration.account_tier_set"` and `metadata: { tierId }`, all inside `withTransaction`. Delete `setAccountPermissions` (grep first — the action file and any tests are its only callers).

Action: `authorize()` (member), parse, call the command, `revalidate()`, map errors through the existing `fail()` helper.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/integration/connector-permissions.test.ts tests/integration/connectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/integrations/commands.ts src/app/\(workspace\)/command-center/integrations/actions.ts tests/integration/connector-permissions.test.ts tests/integration/connectors.test.ts
git commit -m "feat(connectors): setAccountAccessTier replaces binary permission flags"
```

---

### Task 5: Card state machine and tier picker (UI)

**Files:**
- Modify: `src/domains/integrations/queries.ts` (`ConnectorCard` gains `accessTiers` and account `accessTier`)
- Modify: `src/app/(workspace)/command-center/integrations/page.tsx` (drop the Register panel)
- Modify: `src/app/(workspace)/command-center/integrations/connector-catalog.tsx` (state machine, tier picker, Coming soon)
- Modify: `src/app/(workspace)/command-center/integrations/connector-controls.tsx` (tier picker control, inline-alias connect, remove `AccountPermissions`)
- Test: `tests/unit/connector-card-state.test.ts` (new)

**Interfaces:**
- Consumes: `accessTiers` (Task 1 via `listConnectors`), `setAccountAccessTierAction` (Task 4), `startConnectionAction` (exists — takes `{provider, alias}`).
- Produces: `CatalogConnector.accounts[n].accessTier: string | null`; `CatalogConnector.accessTiers: AccessTier[]`; card state function `cardState(connector, envConfigured): "needs_config" | "coming_soon" | "available" | "connecting" | "connected" | "action_needed"` (exported for the unit test).

- [ ] **Step 1: Write the failing state-machine unit test**

`tests/unit/connector-card-state.test.ts` (pure function, no db):

- `active account wins` → `connected`; `connecting account, no active` → `connecting`; `error/expired/revoked, no active/connecting` → `action_needed`; `no accounts, tiers present` → `available`; `no accounts, tiers empty` → `coming_soon`; `connecting attempt with expired attempt row` → `action_needed` (feed an account whose `lastError` is the expired-attempt message). Assert each maps from realistic account-row fixtures.
- `a connecting card never shows Disconnect` — render-level assertion is Playwright's job (Task 8); here assert `cardState` never returns `connecting` when an `active` account exists.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/connector-card-state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `listConnectors` changes and the card redesign**

`queries.ts`: select `accessTier` into the account map; select `integrationCatalog.accessTiers` into `ConnectorCard`.

`connector-catalog.tsx`: export `cardState(connector)` implementing the machine above (needs_config: a provider whose env auth config is missing reports `not_configured` from `startConnectionAction` today — surface it as `needs_config` only when a connect attempt returned that; default missing-env providers to `coming_soon` since they also have no tiers). Category map extends to all 22 providers (Finance: hubspot, salesforce, stripe; Design: figma, canva; Storage: google-drive, dropbox; Meetings: zoom, calendly; and so on — group sensibly, one category per provider). Remove `capabilitySummary` jargon from the card body.

Card bodies per state:
- `connected`: alias, last healthy time, tier control `Agent access: {tier label} ▾` → picker listing that provider's tiers with descriptions; calls `setAccountAccessTierAction`; write-default badge; Disconnect.
- `connecting`: alias + "Finish connecting" (re-runs `startConnectionAction` for the same alias) — no Disconnect, no Connect.
- `available`: one Connect button that prompts for alias inline (small inline input in the card, then `startConnectionAction` + redirect — reuse `ConnectButton`'s redirect logic).
- `action_needed`: plain-language `lastError`, one Reconnect button.
- `coming_soon`: muted card, "Connect {displayName} agents once its tools ship." — no button.
- `needs_config`: names the missing env var (`COMPOSIO_AUTH_CONFIG_{PROVIDER}` uppercased), no button.

`page.tsx`: delete the `Panel title="Register an account"` block and the `RegisterForm` import.

`connector-controls.tsx`: delete `RegisterForm` and `AccountPermissions`; add `TierPicker({ provider, accountId, expectedVersion, current, tiers })` calling `setAccountAccessTierAction`; extend `ConnectButton` to take an inline alias.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/connector-card-state.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/integrations/queries.ts src/app/\(workspace\)/command-center/integrations/
git add tests/unit/connector-card-state.test.ts
git commit -m "feat(connectors): honest card states and per-connection tier picker"
```

---

### Task 6: Playwright journey — connect, restrict, deny, raise, propose

**Files:**
- Create: `tests/e2e/connectors-tier-journey.spec.ts`

**Interfaces:**
- Consumes: everything above, exercised through the real UI.

- [ ] **Step 1: Write the journey spec**

Journey (follow the existing `tests/e2e` harness conventions for auth and workspace seeding):

1. Open `/command-center/integrations` — a provider without tiers renders Coming soon; a connected gmail card shows `Agent access: Read only`.
2. Set the tier picker to `Read + send proposals` — card updates, persists after reload.
3. In the agent surface, invoke `gmail_send` — expect the proposal card (`awaiting_review`), not a denial.
4. Back on Connectors, set the tier back to `Read only`; invoke `gmail_send` again — expect the denial naming the tier control.

If the e2e environment cannot mint a real Composio connection, seed the account row as `active` directly in the test setup (the journey tests tier gating and card states, not the OAuth handshake — that has integration coverage).

- [ ] **Step 2: Run**

Run: `pnpm e2e -- connectors-tier-journey`
Expected: PASS (or explicitly SKIPPED with reason if the e2e harness has no DATABASE_URL — never silently).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/connectors-tier-journey.spec.ts
git commit -m "test(e2e): connectors tier journey — restrict, deny, raise, propose"
```

---

### Task 7: Generic provider read pathway

**Files:**
- Create: `src/domains/integrations/reads/generic.ts`
- Modify: `src/domains/integrations/transport.ts` (nothing if the existing `read` suffices — verify, don't extend)
- Modify: `src/domains/agents/gateway.ts` (`parseCall` gains a generic search/list branch; `readOther` gains the generic case)
- Test: `tests/unit/generic-read.test.ts`

**Interfaces:**
- Consumes: `Transport.read` (GET only), `LIMITS` truncation.
- Produces:
  - `export type GenericReadSpec = { tool: string; capability: Capability; endpoint: string; query?: Record<string, string>; listPath: string; itemText: (item: unknown) => string }` — `listPath` is a dotted path into the response JSON carrying the array.
  - `export async function genericList(transport: Transport, spec: GenericReadSpec, input: { connectedAccountId: string; query?: string; limit?: number }): Promise<{ ok: true; items: string[] } | { ok: false; code: string; message: string }>`
  - A registry constant `GENERIC_READS: Record<string, GenericReadSpec>` that later tasks extend — starts empty.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/generic-read.test.ts` with an in-memory fake `Transport`:

- `maps listPath to item texts and truncates at LIMITS.maxResponseBytes` — fake transport returns 200 items; assert item count respects limit and the joined text stays under the byte bound.
- `a non-2xx becomes a provider_error with the status` — fake returns 403 → `{ ok: false, code: "provider_error" }`.
- `a missing listPath is a read failure, not a crash` — response `{}` → `{ ok: false }` with a message naming the path.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/generic-read.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `genericList` and wire the gateway branch**

`generic.ts`: build the GET request (endpoint + query + optional `q`/search param from `input.query` per spec's `query` template), call `transport.read`, walk `listPath`, map items with `itemText`.

`gateway.ts`: `parseCall` — tools present in `GENERIC_READS` parse as `{ query?: string, limit?: number }`; `readOther` — a `GENERIC_READS[parsed.tool]` hit calls `genericList` and formats items as text lines. Register nothing yet (registry starts empty); the point is that Tasks 8–11 add entries without touching the gateway again.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/generic-read.test.ts tests/unit/provider-capabilities.test.ts`
Expected: PASS (`provider-capabilities.test.ts` proves tool↔capability maps agree; the generic branch must keep it green).

- [ ] **Step 5: Commit**

```bash
git add src/domains/integrations/reads/generic.ts src/domains/agents/gateway.ts tests/unit/generic-read.test.ts
git commit -m "feat(integrations): registry-driven generic provider read over the transport seam"
```

---

### Task 8: Expansion cluster A — Google (calendar, drive, docs, sheets)

**Files:**
- Modify: `src/domains/integrations/capabilities.ts` (`Provider` union, capabilities, `PROVIDER_TOOLS`, `PROVIDER_TIERS`)
- Modify: `src/domains/integrations/reads/generic.ts` (registry entries)
- Modify: `src/domains/integrations/tool-manifest.ts` (schemas + descriptions)
- Create: `src/db/migrations/0230_google_tiers.sql`
- Test: `tests/unit/provider-tiers.test.ts` (extend), `tests/unit/generic-read.test.ts` (endpoint fixtures)

**Interfaces:**
- Consumes: `genericList`, `GENERIC_READS` (Task 7).
- Produces: capabilities `googlecalendar.events.read` (tool `googlecalendar_list_events`), `googledrive.files.read` (`googledrive_search_files`), `googledocs.documents.read` (`googledocs_list_documents`), `googlesheets.sheets.read` (`googlesheets_list_sheets`); each provider's `read_only` tier in `PROVIDER_TIERS`; migration flips `integration_catalog.access_tiers` for the four providers.

- [ ] **Step 1: Extend the failing tests**

`provider-tiers.test.ts`: `PROVIDER_TIERS` now covers `google-calendar`, `google-drive`, `google-docs`, `google-sheets`, each one tier `read_only` whose capabilities all exist; the drift test's migration list gains `0230_google_tiers.sql` (tier JSON in the migration deep-equals the code).
`generic-read.test.ts`: registry entries return fixture responses with the real endpoint paths (`/calendar/v3/events`, Drive `files.list`, Docs list, Sheets list) and `listPath` values (`items`, `files`, `documents`, `sheets`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/provider-tiers.test.ts tests/unit/generic-read.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the four capabilities (kind `read`, riskClass `read`), tool mappings, zod schemas (`{ query?: string, limit?: number }` where the API accepts a search param; plain list otherwise), plain-language descriptions, `GENERIC_READS` entries with `itemText` mappers that render one line per event/file/document/sheet (name + date/id), `PROVIDER_TIERS` entries, and migration `0230` seeding the four providers' `access_tiers` (same JSON shape as Task 1).

Composio base for these tools is the provider's standard API host proxied per connected account — use the same endpoint convention the existing google reads in `src/domains/integrations/gmail/` use (read one to confirm the base-URL pattern; do not invent a new one).

- [ ] **Step 4: Live verification (never in CI)**

With `COMPOSIO_API_KEY` set locally, run a one-off script (throwaway, not committed) executing one listed tool per provider against the operator's connected account. Expected: 200 and a non-empty list for at least calendar and drive. A provider that cannot route does not get its migration — record which and say so in the commit message. If env is absent, mark this step explicitly skipped in the PR description.

- [ ] **Step 5: Run, then commit**

Run: `pnpm vitest run tests/unit/ && pnpm typecheck`
Expected: PASS.

```bash
git add src/domains/integrations/ src/db/migrations/0230_google_tiers.sql tests/unit/
git commit -m "feat(connectors): Google cluster read tools and tiers (calendar, drive, docs, sheets)"
```

---

### Task 9: Expansion cluster B — comms and meetings (discord, zoom, calendly) + notion

**Files:**
- Modify: `src/domains/integrations/capabilities.ts`, `src/domains/integrations/reads/generic.ts`, `src/domains/integrations/tool-manifest.ts`
- Create: `src/db/migrations/0231_comms_tiers.sql`
- Test: extend `tests/unit/provider-tiers.test.ts`, `tests/unit/generic-read.test.ts`

**Interfaces:**
- Consumes: Task 7's registry; Task 8's pattern.
- Produces: `discord.channels.read` (`discord_list_channels`), `zoom.meetings.read` (`zoom_list_meetings`), `calendly.events.read` (`calendly_list_events`), `notion.pages.read` (`notion_search_pages`); `Provider` union grows by `notion`, `discord`, `zoom`, `calendly`; migration `0231` seeds their tiers.

- [ ] **Step 1: Extend the failing tests** — same shape as Task 8: tiers exist with real capabilities, migration JSON matches, registry fixtures for each endpoint.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/unit/provider-tiers.test.ts tests/unit/generic-read.test.ts`, expect FAIL.

- [ ] **Step 3: Implement** — as Task 8; Notion's search endpoint takes a `query` body on POST — if the GET-only transport cannot express it, use Notion's GET list-pages endpoint instead and say so in the tool description ("lists recently updated pages"). Follow Task 8's step 5 verification discipline per provider.

- [ ] **Step 4: Run, then commit** — as Task 8; migration `0231_comms_tiers.sql`.

---

### Task 10: Expansion cluster C — work management (jira, asana, trello, airtable)

**Files:** same set as Task 9; migration `0232_workmgmt_tiers.sql`.

- [ ] **Step 1: Extend the failing tests** — capabilities `jira.issues.read` (`jira_search_issues`), `asana.tasks.read` (`asana_list_tasks`), `trello.cards.read` (`trello_list_cards`), `airtable.records.read` (`airtable_list_records`); tiers + migration parity.
- [ ] **Step 2: Run to verify failure** — expected FAIL.
- [ ] **Step 3: Implement** — as Task 8. Airtable lists are per-base; the tool lists bases and records for a `baseId` argument if the API demands one — schema gains `baseId?: string` and the description says what happens without it.
- [ ] **Step 4: Run, then commit** — as Task 8; migration `0232_workmgmt_tiers.sql`.

---

### Task 11: Expansion cluster D — design, storage, CRM, finance (figma, canva, dropbox, hubspot, salesforce, stripe)

**Files:** same set; migration `0233_crm_tiers.sql`.

- [ ] **Step 1: Extend the failing tests** — capabilities `figma.files.read` (`figma_list_files`), `canva.designs.read` (`canva_list_designs`), `dropbox.files.read` (`dropbox_list_files`), `hubspot.contacts.read` (`hubspot_list_contacts`), `salesforce.records.read` (`salesforce_search_records`), `stripe.payments.read` (`stripe_list_payments`); tiers + migration parity. Stripe's tier description must say "read-only; charges are never agent-proposed in this tier".
- [ ] **Step 2: Run to verify failure** — expected FAIL.
- [ ] **Step 3: Implement** — as Task 8. Dropbox listing is RPC-shaped (POST) — if the GET-only transport cannot express it, ship the tool against Dropbox's shared-link/`list_folder` GET equivalent if one exists, otherwise leave dropbox out of the migration with the reason recorded (same honesty rule as Task 8 step 4). Salesforce/Stripe stay `read` only; their `external_write` capabilities remain proposal-shaped and unshipped.
- [ ] **Step 4: Run, then commit** — as Task 8; migration `0233_crm_tiers.sql`.

---

### Task 12: Catalog honesty integration test and docs

**Files:**
- Create: `tests/integration/catalog-honesty.test.ts`
- Modify: `agents/architecture.md` (integrations domain paragraph: access tiers, generic read registry)
- Modify: `docs/axiom-product-spec.md` connectors section (tier model in the owner's words)
- Modify: `src/domains/integrations/capabilities.ts` header comment (tiers are enforcement; risk table is display)

**Interfaces:**
- Consumes: the finished catalog, tiers, and gateway.

- [ ] **Step 1: Write the failing integration test**

Against real Postgres with all migrations applied:

- `every catalog provider with tiers can route its lowest tier` — for each `integration_catalog` row with non-empty `access_tiers`, assert every capability in `tiers[0].capabilities` exists in `CAPABILITIES`, maps to a tool in `PROVIDER_TOOLS`, and is a gateway-routable kind (`read` or `proposal`).
- `every catalog provider is either connectable or explicitly coming soon` — assert each row's `access_tiers` is either empty or a non-empty tier list (no half states).
- `gmail keeps two tiers and stripe stays read-only` — pins the headline decisions.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/integration/catalog-honesty.test.ts`; expected FAIL only if a prior task's migration or code drifted (this is the closing net — if it fails, fix the drift in the owning file, not the test).

- [ ] **Step 3: Update the docs** — architecture paragraph: the integrations domain now owns access tiers and the generic read registry; product spec connectors section: the tier model and the five card states in the owner's words; capabilities.ts header: two lines.

- [ ] **Step 4: Run the full check and commit**

Run: `pnpm check`
Expected: PASS (lint, typecheck, tests, build).

```bash
git add tests/integration/catalog-honesty.test.ts agents/architecture.md docs/axiom-product-spec.md src/domains/integrations/capabilities.ts
git commit -m "test(connectors): catalog honesty invariant; docs for tiers and card states"
```

---

## Follow-ups (recorded, not in this plan)

- Drop `external_accounts.allow_read` / `allow_write` once no code reads them (grep in a later slice; migration `0234+`).
- `DEFAULT_ALLOWED_TOOLS` gains the new read capabilities so default profiles can use them — evaluated per-profile in a follow-up slice, not silently here.
