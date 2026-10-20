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

## File intake

### A sniff mismatch returns 201 instead of quarantining the original

**What:** `tests/integration/file-intake.test.ts` ("a sniff mismatch quarantines
the original instead of rejecting it") asserts a 200 with `fileStatus:
"quarantined"`; the route returns 201.

**Why:** The suite is red on every PR that runs integration tests, so a real
regression in file intake has nowhere to show up. A wrong file status is also the
difference between a quarantined upload and an accepted one.

**Context:** Reproduced on a pristine `origin/main` checkout (`cf47131`) in a
throwaway worktree with a local Postgres: same 201-vs-200, so it is not
introduced by any one branch. The route and the test disagree on the contract;
decide which is correct before changing the assertion. Failing output:

```
AssertionError: expected 201 to be 200
 ❯ tests/integration/file-intake.test.ts:118:24
   expect(res.status).toBe(200);
```

**Effort:** S
**Priority:** P0
**Depends on:** None

## Completed

- ASH-120 F01–F03 (scope ADR, glossary, canonical identity schema, auth
  spine): **v-unversioned** (2026-10-18), PR #10.
