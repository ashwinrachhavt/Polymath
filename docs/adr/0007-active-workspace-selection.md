# ADR 0007: Active workspace selection (proposal)

Status: proposed. Tracks ASH-176. Decision owner: Ashwin.

## Problem

`resolveAuthContext` returns the user's first active membership. That was
correct while every user owned exactly one personal workspace. Invitations
(ASH-121 AC02, merged default-off) let a user hold two memberships, for
example their own workspace and their brother's books. Nothing chooses which
one a request acts in, so invites must stay unexposed until this is decided.

## Options

1. **Session claim.** Store the active workspace id in a signed cookie (or Clerk
   session metadata). Every request re-proves it with `verifyWorkspaceBinding`:
   an active membership must exist right now, else fall back to the personal
   workspace. Switching is a server action that validates membership and sets
   the cookie.
2. **Workspace in the URL** (`/w/<slug>/...`). Explicit and linkable, but every
   route, link and the app launcher change. Large churn for two users.
3. **Per-user default column** (`users.default_workspace_id`). Simple, but two
   browser tabs cannot act in different workspaces and a stale default is silent.

## Proposed

Option 1. The cookie is only a hint: authorization always re-reads the
membership, so a removed or suspended member loses access on the next request
(this also closes the AC08 stale-claim concern for workspace choice). Add a
workspace switcher to the shell only when the user has more than one active
membership, so Ashwin's single-workspace experience is unchanged.

## Consequences

- `resolveAuthContext` takes an optional preferred workspace id; a missing,
  suspended or removed membership falls back to the first active one.
- Machine clients keep their own workspace binding (api_clients.workspace_id).
- Background jobs already carry workspace_id explicitly (outbox, jobs).
- Cache keys and tags must include workspace id (verify in the cache-tags audit
  before enabling).

## Questions for the owner

- Should a user's personal workspace stay the default after accepting an invite?
- Does the accounting use case (dad doing his brother's books) need a separate
  workspace per client, or one workspace with restricted resource grants?
  This is the product question behind the whole model; the rethink should settle it first.
