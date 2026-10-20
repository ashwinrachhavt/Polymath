# TODOS

Deferred work recorded by /ship on 2026-10-18, from the ASH-120 tranche-1 branch
(`ashwinr/ash-120-workspace-access`). Organized by component; priorities P0–P4.

## Identity / authorization

**Priority:** P1

- Wire `requireRole` and `assertWorkspaceScope` into every server entry point
  (server actions, route handlers). The guards exist (`src/lib/auth/guards.ts`)
  and the ADR's authorization matrix is the target state; today only the
  resolution spine (`identity/resolve.ts` via `src/lib/auth.ts`) is enforced.
  This is ASH-120 F04+ enforcement work.

**Priority:** P2

- Postgres RLS as defense-in-depth over the `workspace_id` query-scope check.
  Deferred by ADR 0001 to the F11/F12 benchmark/rollout tickets; needs the
  non-owner/non-BYPASSRLS runtime role and connection-identity tests first.
- Constrain `account_person_links.method` to a CHECK over its two known values
  (`verified`, `review`) once a second write path exists.
- Workspace-leading indexes for `party_relationships_person_idx` and
  `contact_points_value_idx` when the first real query paths arrive.

## Roles

**Priority:** P4

- Custom role definitions beyond the four fixed roles (owner/admin/member/
  viewer): post-v1 by ADR 0001; revisit when a second workspace shape exists.

## E2E

**Priority:** P3

- Playwright coverage of the legacy `/apps/**` preview screens still assumes
  the pre-split IA in places (switch-product journeys); reconcile with the
  launcher now that canonical chrome is single-sourced.

## Completed

- ASH-120 F01–F03 (scope ADR, glossary, canonical identity schema, auth
  spine): **v-unversioned** (2026-10-18), PR #10.

## Inbox / command center

**Priority:** P3

- Arrow-key roving through inbox list rows. **What:** roving tabindex or
  arrow-key navigation across capture rows, complementing the plain-link
  navigation shipped with the two-pane redesign. **Why:** keyboard-first
  users clear a 50-row queue without tabbing through every row; the design
  review (D12, 2026-10-20) deferred it to keep the keyboard model minimal.
  **Pros:** power-user speed through the queue; consistent with Linear-style
  keyboard workflows. **Cons:** a new a11y pattern to maintain and test;
  focus-management edge cases with the detail pane. **Context:** rows are
  plain links per the a11y spec in
  `docs/superpowers/specs/2026-10-20-inbox-redesign-and-extraction-cleanup.md`;
  revisit when the first keyboard-first feedback arrives. **Depends on:**
  the two-pane inbox shipping first.
