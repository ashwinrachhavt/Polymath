# Activating Notion-style workspace tenancy

**Date:** 2026-11-03
**Status:** approved design — D1 (multi-workspace resolution) implemented in this change; D2–D6 staged behind it
**Evidence base:** current-state identity map, server/scoping seams, UI surface, and schema/migration conventions (read-only research reports, 2026-11-03)

---

## Why

Polymath asks for Notion-style tenancy: a user belongs to one or many
workspaces, is a member of different workspaces, with sharing and inviting.
Research overturned the premise that this must be built — **the tenancy data
model already exists and is complete**: `workspaces` (name, unique slug,
`is_personal`, `onboarded_at`), `memberships` (roles
`owner|admin|member|viewer`, status `invited|active|suspended|removed`, unique
per workspace+user), and `invitations` (hashed token, pending partial-unique,
`role <> 'owner'` guard) all live in `src/domains/identity/`. Every domain
schema carries a `workspace_id` tenant column via `tenantId()`
(`src/db/columns.ts`), and queries scope at the source
(`eq(captures.workspaceId, auth.workspaceId)`).

What is missing is **activation**:

1. `resolveAuthContext` (`src/domains/identity/resolve.ts`) returns the first
   active membership (`limit 1`) — there is no notion of a chosen active
   workspace.
2. The invitation write lifecycle (`src/domains/identity/invitations.ts`) is
   wired but has zero route callers — marked "Default off."
3. There is no workspace switcher, no create-workspace flow, and no routing
   for any of it. A read-only Access console ships at
   `src/app/(workspace)/settings/access/page.tsx`.
4. Nothing proves cross-workspace isolation end to end; the one 404-parity
   check (`src/app/api/v1/runs/[runId]/stream/route.ts`) has no HTTP-level
   test (TODOS.md asks for one).

Decision: activate the existing model — multi-membership resolution with a
per-device active-workspace cookie, a top-bar switcher, a create-workspace
flow, the invitation lifecycle routed through the existing house patterns, a
members-management upgrade of the Access console, and a cross-workspace
isolation harness that makes tenancy regressions fail CI. **Zero new tables
and zero migrations.**

Out of scope (flagged, not built): per-resource sharing via the
existing-but-unenforced `resource_grants` table; email delivery for
invitations (token-link invite + sign-in email-match surfacing instead);
workspace deletion; owner transfer; adopting Clerk Organizations.

---

## Locked decisions

**1 — Keep app-owned memberships; do not adopt Clerk Organizations.**
`@clerk/nextjs` is used purely for session identity; Clerk Organizations are
referenced nowhere. Roles, status lifecycle, unique constraints, guards, and
the audit trail are already built in Postgres. Moving identity onto Clerk orgs
would re-platform a working system. *Reversal condition:* if SSO/SCIM becomes
a requirement, map Clerk orgs onto workspaces then, behind the same resolver
seam.

**2 — The active workspace is a per-device cookie, validated on every
request.** The resolver reads the cookie, checks it against the user's active
memberships, and falls back to the personal workspace (then first active) when
absent or stale. No schema change; per-device semantics match how people
actually work; the resolver is the single seam every entry point already
trusts. The alternative (persisting `last_active_workspace_id` on `users`)
syncs state across devices and adds a migration for no observable benefit now.
*Reversal condition:* if cross-device "reopen last workspace" is wanted,
persist on `users` later without touching call sites.

**3 — Invitations are accepted by token link, not email.** No email provider
exists in the repo. v1: the inviter shares the invitation link (Notion's
invite-link pattern) and pending invitations surface for a signed-in user
whose Clerk email matches. *Reversal condition:* wire an email provider later;
the table and lifecycle already support it.

**4 — Any signed-in user may create a workspace; the creator owns it** (D3).
Notion parity. Slug collisions return authored errors via `action-error.ts`.

---

## D1 — Multi-workspace resolution (the seam) — implemented in this change

`resolveAuthContext` keeps its signature and `AuthContext` shape. The lookup
changed from "first active membership" to "cookie-selected active membership
with deterministic fallbacks":

```
memberships = listActiveMembershipsWithWorkspace(clerkUserId)   // one indexed read, oldest first
if empty            -> provisionFirstSignIn(clerkUserId)        // existing provisioning, byte-identical
requested           = readActiveWorkspaceCookie()               // src/lib/active-workspace.ts
selected            = find(workspaceId == requested)            // cookie wins when membership is active
  ?? find(isPersonal)                                           // stale/absent cookie -> personal
  ?? memberships[0]                                             // no personal -> first active
```

Invariants, each pinned in `tests/integration/auth-resolution.test.ts`:

- Cookie-selected membership wins when it names an active membership.
- A stale cookie — a workspace the user never belonged to, or one whose
  membership was later suspended or removed — falls back silently to the
  personal workspace. Membership rows drop out of the query by construction,
  so the cookie never needs to be "invalidated," only outvoted.
- No cookie with no personal workspace resolves the first active membership
  (deterministic by `created_at`, then id).
- The machine-client path is byte-identical: `getAnyAuthContext` resolves
  companion and m2m/api-key clients from their `api_clients` binding and never
  reaches `resolveAuthContext`, so the cookie is a human-session concept by
  construction. Pinned by a test that sets the cookie and proves
  `resolveCompanionToken` still follows the binding.

New files: `src/lib/active-workspace.ts` (read/write the
`polymath_active_workspace` cookie — httpOnly, sameSite lax, secure in
production, one-year max age, path `/`) and
`src/app/(workspace)/settings/workspaces/actions.ts` (the
`switchWorkspaceAction`).

`switchWorkspaceAction` is self-service for every role (`requireRole(auth,
"viewer")` is the floor of the ranking): it re-proves the membership in the
database via `activeMembershipRole` — a stale UI list can offer nothing the
membership table disagrees with — then moves the cookie, bumps the
workspace-scoped cache tags for the new context, and invalidates the root
layout (`revalidatePath("/", "layout")`), because a context change is not a
single-page event.

Switching mid-page is a full context change (layout revalidate), never a
partial refresh.

---

## D2 — Workspace switcher (staged)

New `src/components/shell/workspace-switcher.tsx`, mounted in
`src/components/shell/top-bar.tsx` beside the breadcrumb, built as a Radix
`Popover` per `user-menu-clerk.tsx` (the established menu pattern — no new
primitives). Rows: every active membership with a role badge and a check on
the current one; a "pending invitation" row when the user's Clerk email
matches an open invitation; a "Create workspace" entry. Selecting a workspace
calls `switchWorkspaceAction`. New routes register in `src/lib/navigation.ts`.

Edge cases: user with only a personal workspace sees one row plus "Create";
the stale-cookie case is invisible (the resolver already fell back).

## D3 — Create workspace (staged)

New route `src/app/(workspace)/workspaces/create/page.tsx` + colocated
`actions.ts`; new domain command `createWorkspace` shaped like
`invitations.ts` (`withTransaction`, insert workspace + owner membership,
`recordAudit`). Creator becomes owner and lands in the new workspace.
`ConflictError` on slug collision → authored copy via `action-error.ts`.

## D4 — Invitation lifecycle, routed (staged)

Server actions in `src/app/(workspace)/settings/actions.ts` (the Access
console's colocated actions file) call the existing domain functions:
`createInvitation` (owner today, admin+ when routed), `revokeInvitation`.
Acceptance is a route handler that requires a signed-in session, matches the
invitation's pending email to the session's Clerk email, calls
`acceptInvitation`, and records audit. States already modeled in the table:
`pending` (counts against the partial-unique index — one open invite per
email per workspace), `accepted`, `revoked`. Accept on a revoked or spent
token: same authored error, no state change.

## D5 — Members management (staged)

Extend the read-only `settings/access/page.tsx` into working management using
`changeMembership`: change role (admin+), remove member (admin+), leave
workspace (self-service, member+). **Invariant:** the last active owner of a
workspace cannot be demoted or removed — enforced in the command
(`MembershipLifecycleError("last_owner")`), not the UI. Permission states:
member sees the table without action buttons; admin sees all actions except
owner rows; owner sees everything except self-demotion while sole owner.

## D6 — Cross-workspace isolation harness (staged)

New `tests/integration/tenant-isolation.test.ts`: a shared fixture seeds two
workspaces with distinct users and rows in every domain; for each module in
the scoping-surface enumeration, queries run under workspace-1 auth must
return zero workspace-2 rows and vice versa. The suite also carries the
HTTP-level 404-parity test TODOS.md asks for (run stream route: a
foreign-workspace id answers exactly like a missing one). Any future unscoped
query fails CI.

---

## Verification

| Deliverable | Verifies via | Must hold |
| --- | --- | --- |
| D1 resolver | `tests/integration/auth-resolution.test.ts` (extended in this change) | Cookie-selected membership wins; stale cookie → personal; no cookie → first active; machine path byte-identical; existing provisioning tests untouched and green |
| D2 switcher | Playwright journey + axe | Switch between two workspaces and observe the data context change on a real surface; zero pageerrors; keyboard-operable |
| D3 create | Integration + Playwright | Workspace + owner membership + audit row exist; slug conflict returns authored error; created workspace is entered immediately |
| D4 invitations | Integration + Playwright (second dev user) | create/revoke/accept happy paths; member forbidden on invite admin; duplicate pending invite blocked; invited user accepts and appears as member |
| D5 members | Integration + Playwright | Role change persists; remove member works; last-owner removal/demotion blocked; leave works for non-sole-owner |
| D6 harness | `pnpm test` | Isolation suite green on every enumerated domain module; foreign-workspace 404 parity green at HTTP level |
| Every PR | `pnpm check` (lint, typecheck, test, inventory:check, build) + CI migration/drift gates | Green; zero migrations — any unavoidable migration follows the 0282 snapshot roll-forward procedure |

Open questions (non-blocking, recorded so they are not re-litigated inside a
PR): the email provider choice (D4 reversal condition) and workspace deletion
UX are deferred product calls.
