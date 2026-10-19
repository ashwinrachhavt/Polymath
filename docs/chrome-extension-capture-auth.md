# Chrome extension → Polymath capture: how auth resolves, and what is missing

Status note, 2026-10-19. Source citations are `file:line` against the repo at
`feat/ui-simplification-pass`.

## (a) How auth actually resolves today

Two guards, one identity shape.

- `getAuthContext` (`src/lib/auth.ts:41-55`) is the browser/server-action path.
  It calls `auth()` with the default token type, requires a `userId`, and
  returns `resolveAuthContext(userId)`.
- `getAnyAuthContext` (`src/lib/auth.ts:72-102`) is the `/api/v1/**` path. It
  calls `auth({ acceptsToken: ["session_token", "m2m_token", "api_key"] })`
  (`src/lib/auth.ts:83`).
  - `session_token` or any session carrying `userId` → `resolveAuthContext`
    (`src/lib/auth.ts:85-87`).
  - `m2m_token` (subject `machineId`) or `api_key` (subject `id`) → subject is
    looked up in `api_clients.token_hash` (`src/lib/auth.ts:88-99`,
    `src/domains/identity/machine.ts:35-47`).
- `authedHandler` (`src/lib/auth.ts:105-124`) wraps route handlers and maps
  `UnauthorizedError` → 401, `ForbiddenError` → 403 (or 429 when
  `rate_limited`), `ForbiddenRoleError` → 403.
- The edge proxy applies the same policy: `/api/v1/**` is protected with
  `{ token: ["session_token", "m2m_token", "api_key"] }`
  (`src/proxy.ts:24-30`), so an extension must satisfy the proxy *and*
  `getAnyAuthContext`. Next 16 renamed middleware to `proxy.ts`
  (`src/proxy.ts:6`).
- Clerk is optional locally: `clerkConfigured` is true only when both
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are set
  (`src/lib/clerk.ts:10-12`). When false, both guards short-circuit to
  `resolveAuthContext("dev-user")` outside production and VITEST
  (`src/lib/auth.ts:49-51`, `:80-82`). **The local `.env` has both keys
  populated**, so this fallback does not apply on this machine.

### What a machine client's AuthContext looks like

`resolveMachineClient` returns `{ clientId, workspaceId, role: "owner" }`
(`src/domains/identity/machine.ts:70-79`), and `getAnyAuthContext` maps that to
`{ userId: clientId, workspaceId, role }` (`src/lib/auth.ts:94-98`). That
`userId` is the **api_clients row id**, not a users row id. It is written into
`created_by`/`updated_by`. That is safe today only because those columns carry
no foreign key (`src/db/columns.ts:10-14`); adding one later would break every
companion-authored row. Noted, not fixed.

Machine clients are rate-limited to 1,000 requests/day/client, enforced by an
atomic upsert into `api_client_usage` (`src/domains/identity/machine.ts:17`,
`:55-68`).

## (b) What blocks a Chrome extension right now

1. **No way to obtain a credential.** `resolveMachineClient` only *reads*
   `api_clients`. Grepping the whole repo for `apiClients`/`api_clients` finds
   only the schema, the resolver, and the generated migrations — there is no
   insert, no pairing UI, no seed, no CLI
   (`src/domains/identity/schema.ts:94-110`,
   `src/domains/identity/machine.ts:3,38-47`,
   `src/db/migrations/0001_greedy_whistler.sql:805`). The schema comment says
   "the credential itself is shown once at pairing"
   (`src/domains/identity/schema.ts:91-92`), but the pairing flow does not
   exist. Product docs likewise treat it as unbuilt
   (`docs/axiom-product-spec.md:330`).
2. **No capture endpoint.** There is no `POST /api/v1/captures`; the existing
   `/api/v1` routes are `documents/[documentId]/extract`, `dossiers`, `drafts`,
   `files`, `runs`, `search` (see `src/app/api/v1/`). Captures are written by
   `createCapture` (`src/domains/capture/commands.ts:27-59`), reachable only
   from the inbox server action (`src/app/(workspace)/command-center/inbox/actions.ts:24-33`).
3. **No CORS.** No route exports `OPTIONS` and nothing sets
   `Access-Control-Allow-Origin` anywhere in `src/` — a background service
   worker `fetch` to a different origin will be blocked. Actually, service
   workers with `host_permissions` bypass page CORS; content scripts do **not**.
   The extension's `fetch` calls live in `api.js`, loaded into the page as a
   content script (`manifest.json:42`), so those requests are subject to CORS.
4. **Wrong origin in the manifest.** The vendored extension only grants
   `http://localhost:8000/*` and `http://localhost:3001/*`
   (`extensions/chrome/manifest.json:8-9`) and defaults to `localhost:8000`
   (`extensions/chrome/api.js:8`, `extensions/chrome/sidepanel.js:23`). Polymath's
   dev server is Next on **3000**.

## (c) Smallest correct path, with tradeoffs

### Option 1 — Clerk `api_key` tokens (recommended, production-shaped)

`@clerk/nextjs@7.9.14` ships `@clerk/backend@3.23.2`, which exposes
`clerkClient.apiKeys.create/get/revoke/verify`
(`node_modules/.pnpm/@clerk+backend@3.23.2.../dist/api/endpoints/APIKeysApi.d.ts:53-99`;
`APIKey` carries `subject`, `scopes`, `secret`
`.../dist/api/resources/APIKey.d.ts:5-37`). Clerk verifies the token; Polymath
then maps the subject onto an `api_clients` row as it already does
(`src/lib/auth.ts:88-99`).

- Extension sends `Authorization: Bearer <secret>`.
- Requires: a one-time create call (script or a Settings action) that mints a
  Clerk API key **and** inserts the matching `api_clients` row with
  `tokenHash = keyId`, `kind: "companion"`, `status: "active"`.
- Tradeoff: two systems to keep in sync (Clerk key + Polymath row). The `tokenHash`
  column stores the Clerk *subject id*, not a hash of the secret
  (`src/domains/identity/machine.ts:29-33`, `:46`) — name is a misnomer worth
  documenting. Revocation must happen in both places.
- Note: `createdBy` becomes the api_clients id (see (a)).

### Option 2 — session token from the extension

Clerk's browser SDK can hand the extension a session JWT, and
`getAnyAuthContext` accepts `session_token` (`src/lib/auth.ts:83`).
Requires the user to sign in inside an extension page (`chrome.identity`),
which means a Clerk JS bundle in the extension. No `api_clients` row needed.
Tradeoff: heaviest client, and the session token expires (extension must
refresh), but it is the only path with zero new server-side tables.

### Option 3 — dev-only bearer (fastest to "capturing today")

Gate a static `COMPANION_DEV_TOKEN` behind
`process.env.NODE_ENV !== "production"` in `getAnyAuthContext`, resolving to a
fixed workspace. Mirrors the existing `dev-user` shortcut
(`src/lib/auth.ts:73-82`). Tradeoff: a second unauthenticated-for-real path that
must be deleted before any shared deploy, and it bypasses the `api_clients`
audit trail entirely. Acceptable only as a temporary local unblock.

### Regardless of option, the endpoint

`POST /api/v1/captures`, shaped like the existing routes
(`src/app/api/v1/search/route.ts:18-29`): `authedHandler` +
`requireRole(auth, "member")` + zod parse + `problemResponse` on failure.
Body: `{ text?: string, url?: string }` → `createCapture`
(`src/domains/capture/commands.ts:27-59`), which sets `kind`
`text`/`url`, `source: "quick_capture"`, `rawPayload`, and an audit row, all in
one transaction. For extension-originated captures, `source` should be
`"companion"` (enum value already exists,
`src/domains/capture/schema.ts:22-29`). Duplicate URLs collide on the partial
unique index `(workspace_id, source, url)` and surface as
`ConflictError` → 409 (`src/domains/capture/schema.ts:80-82`,
`src/domains/capture/commands.ts:53-57`).

Idempotency: the repo convention is `withReceipt(tx, auth, key, request, run)`
(`src/domains/audit/receipt.ts:32-65`), keyed on an `Idempotency-Key` UUID
header as in `files` (`src/app/api/v1/files/route.ts:54-57`). `createCapture`
does **not** use it today; a companion retry needs either that or the URL
uniqueness to prevent duplicates.

Also required: add the Polymath origin to `host_permissions`, point
`_defaultUrl` at it, and add a CORS/`OPTIONS` handler for the content-script
fetches.
