# api.md — Resources, routes, and how to add them

**Purpose:** how to design and add an API surface here. The core model is in the
Tech Spec; this file is the working rules an agent needs.

## The model

Twelve core resources. Plural nouns, no prefixes, no verbs. Foreign keys as
`<singular>_id`. REST paths follow the names exactly.

```text
workspaces  users  memberships  sources  notes  claims
cards  links  tasks  sessions  areas  runs
```

| Resource | Path | Example |
|---|---|---|
| Sources | `/v1/sources` | `POST /v1/sources`, `GET /v1/sources/:id` |
| Notes | `/v1/notes` | `GET /v1/notes?area=<id>&sort=-updated_at` |
| Claims | `/v1/claims` | `GET /v1/claims?source=<id>` |
| Cards | `/v1/cards` | `GET /v1/cards?due=now` |
| Links | `/v1/links` | `POST /v1/links` with `from`, `to`, `relation`, `reason` |
| Tasks | `/v1/tasks` | `GET /v1/tasks?state=open` |
| Sessions | `/v1/sessions` | `POST /v1/sessions`, `POST /v1/sessions/:id/complete` |
| Areas | `/v1/areas` | `GET /v1/areas/:id/progress` |
| Runs | `/v1/runs` | `POST /v1/runs` (optional `skillId` pins the run to an enabled skill), `POST /v1/runs/:id/cancel`, `POST /v1/runs/:id/retry` |

Everything else is a capability over these. A proposal is `POST /v1/proposals`
with a `target`; a stone is a session outcome, not a resource with its own
lifecycle.

## Conventions

- **Plural nouns in the path.** `/v1/notes`, never `/v1/note` or `/v1/getNotes`.
- **No verbs in the path** except an explicit state action on a resource:
  `/complete`, `/cancel`, `/accept`. If you need more than a handful, the
  resource is wrong.
- **Flat, not nested, beyond one level.** `/v1/notes?source=<id>` beats
  `/v1/sources/:id/notes`.
- **Snake case in JSON**, matching column names. No camel/snake translation layer.
- **IDs are UUIDs**, opaque, never sequential.
- **Timestamps are ISO 8601 with offset**, UTC on the wire.

## Every mutation

In this order:

1. Authenticate.
2. Resolve `AuthContext` — user and workspace, server-side.
3. Parse input with Zod. Everything from a client is untrusted.
4. Check the idempotency key against `request_receipts`.
5. Check the expected `version`.
6. Run the domain command.
7. Write audit and outbox in the same transaction.
8. Invalidate cache tags.
9. Return the updated resource with its new `version`.

A mutation that skips 4, 5, or 7 is a bug, not a shortcut.

## Headers

| Header | Purpose |
|---|---|
| `Idempotency-Key` | Required on every mutation. A UUID. Reuse with different input is a conflict. |
| `If-Match` | The `version` the client expects. A mismatch is `409`. |
| `X-Request-Id` | Optional client correlation id, echoed back. |

## Responses

- `200` read or update, `201` create, `204` delete.
- Errors are problem+json: `type`, `title`, `status`, `code`, `detail`.
- Codes are stable and added, never repurposed.
- A list is `{ data: [...], next_cursor }`. Cursors, not offsets.
- Never return a partial result as whole. If a related fetch failed, the resource
  carries a `degraded` field naming what is missing.

## Pagination and filtering

- Cursor pagination on every collection. Default 25, max 100.
- Filters are query parameters named after columns: `?state=open`, `?area=<id>`.
- Sort is `?sort=-updated_at`. Prefix `-` for descending.
- No filter may be applied without `workspace_id` in scope, ever.

## Where things live

| Surface | Location |
|---|---|
| HTTP endpoints | `src/app/api/v1/**/route.ts` |
| Server actions | `src/app/**/actions.ts` |
| Domain commands | `src/domains/<domain>/commands.ts` |
| Domain queries | `src/domains/<domain>/queries.ts` |
| Schemas | `src/domains/<domain>/schema.ts` |
| Error shape | `src/lib/problems.ts` |

A route handler parses and delegates. It does not contain business logic. A
server action is the same: parse, call the command, return.

## Adding an endpoint

1. Does the resource already exist? If yes, extend the domain query, not the route.
2. Is this a first-party mutation? It is a server action, not a route handler.
3. Route handlers are for `/api/v1`, webhooks, SSE, signed files, health, and
   kickoff. If a route handler is being added for anything else, stop and check.
4. Write the command in the domain, with idempotency and version checks.
5. Write audit and outbox in the same transaction.
6. Add the test that fails if the invariant breaks.
7. Update this file if a new resource or path family appears.

## Webhooks

- Verify the signature before parsing the body.
- Deduplicate on provider event id in `webhook_inbox`.
- Return `200` fast; do the work in the outbox, never inline.
- An unverified or duplicate webhook returns `200` with no side effect, not `4xx`.

## What not to do

- No `/v1/getX` or `/v1/createX` paths.
- No resource named after a screen.
- No DTO layer that mirrors the model.
- No client-supplied `workspace_id` or `user_id`.
- No retry without an idempotency key.
- No unbounded list response.
- No endpoint that queries another domain's tables directly.
