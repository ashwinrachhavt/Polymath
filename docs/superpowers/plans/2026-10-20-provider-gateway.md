# Agent provider gateway — slice 1 implementation plan

**Spec:** `docs/superpowers/specs/2026-10-20-agent-provider-gateway-design.md`
(revision 2). This plan covers **slice 1 only**: Gmail read plus a complete
approved-send path. It does not plan Linear, GitHub, or Vercel.

**Branch:** `feat/eve-agents-chat-composio`.

**What ships when this plan is done**

- eve reaches Gmail through one MCP endpoint (`POST /api/mcp`) with a per-run
  token; the URL proxy `connected_read` is gone.
- `gmail_search` and `gmail_read_thread` read through Composio.
- `gmail_send` writes an `action_proposals` row with a revision and never calls
  a provider from inside a turn.
- Approving a Gmail proposal on `/reviews` executes it exactly once. Success,
  failure, and unknown are three distinct outcomes, and an unknown blocks retry
  until reconciliation settles it.
- A connected account can be revoked, and revocation stops reads and sends
  immediately.
- Calendar, the one other write path, gets the same enforcement.
- Evals cannot reach a provider even when a tool is unstubbed.

---

## Global constraints

- **No new dependencies.** `zod` and `drizzle-orm` are present. The MCP
  endpoint is implemented directly as JSON-RPC over `POST`; do not add the
  Model Context Protocol SDK as a direct dependency for three methods.
- **One writer.** The only code that calls a provider to change state is
  `src/domains/actions/executor.ts` → `src/domains/integrations/gmail/send.ts`.
  The gateway's tool table has no write handler; `gmail_send` creates a proposal
  and returns `awaiting_review`. A review must be able to see this by reading
  `src/domains/agents/gateway.ts` top to bottom.
- **Attempt before call.** An `action_attempts` row is inserted with
  `status='unknown'`, `reconciliation='pending'` and a unique
  `idempotency_key` *before* the provider is contacted. The same transaction
  never spans the provider call (`agents/coding.md`).
- **Unknown is never retried automatically.** Only reconciliation may move an
  unknown attempt, and only when the provider gives a definite answer.
- **eve holds no provider credential.** It holds `EVE_GATEWAY_SECRET` and mints
  a 60-second token naming one run id. Composio credentials stay in
  `src/domains/integrations/`.
- **Flows point one way:** `app → domains → integrations → lib`. Cross-domain
  work goes through the `actions` domain's public commands, which is how
  `src/domains/calendar/proposals.ts` already calls `createProposal` /
  `decideProposal`.
- **Every provider shape is parsed with `zod` at the boundary**, from a fixture.
  CI never calls a provider.
- **Invariants are proven against real Postgres**, never a mock
  (`tests/helpers/test-workspace.ts`).
- **Migrations are forward-only.** Generate with drizzle, review the SQL, never
  edit it after it lands. `pnpm check:migrations main` must pass.
- **No new outbox topic** in this slice. Every state change writes `recordAudit`
  in the same transaction; nothing consumes an outbox event for these actions.
- **Vocabulary** is the spec's: *capability*, *proposal*, *revision*,
  *attempt*, *transport*, *gateway*, *executor*. Do not introduce "connector",
  "handler", or "effect job" for these.
- **UI copy** follows `agents/product.md`: an unknown outcome reads
  *"Checking whether this was sent."* — never "Failed, retry".

**Test commands used below**

```sh
# unit
pnpm exec vitest run --project unit tests/unit/<file>.test.ts

# integration (real Postgres)
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/<file>.test.ts

# the gate
pnpm typecheck && pnpm lint && pnpm test
```

---

## Task 1 — Prove the Composio proxy accepts a write

This is the spec's one unverified assumption (§2). Everything in Tasks 7–8
depends on the answer, so it is proven before either is written.

**Files:** a throwaway `scripts/spike-composio-write.ts` (deleted in the same
change), and `docs/superpowers/specs/2026-10-20-agent-provider-gateway-design.md`
§2 (evidence row).

### What changes

1. Write a script that sends one message through
   `https://backend.composio.dev/api/v3/tools/execute/proxy` using the same
   request shape as `executeComposioRead` in
   `src/domains/integrations/composio.ts`:

   ```json
   {
     "connected_account_id": "ca_…",
     "endpoint": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
     "method": "POST",
     "body": { "raw": "<base64url RFC 2822>" },
     "parameters": []
   }
   ```

   The message is `To:` the owner's own address, subject
   `Polymath gateway spike <uuid>`, one line of body.
2. Record three facts in the spec's §2 table: whether the proxy forwards the
   `POST`, the exact success body shape (`data.id`, `data.threadId`,
   `data.labelIds`), and the exact body a provider 4xx produces.
3. Delete the script. No credential, message id, or address lands in the repo.

**Fallback, decided in the same task.** If the proxy refuses non-GET methods,
stop before Task 7 and open its own ticket: the send path calls
`https://gmail.googleapis.com/gmail/v1/users/me/messages/send` directly with a
token fetched from Composio's connected-account endpoint, behind the same
`src/domains/integrations/gmail/send.ts` seam. Tasks 2–6 and 9–12 are unaffected
and may proceed.

### Acceptance

```sh
# manual, once, with a real connected account; output pasted into the PR
COMPOSIO_API_KEY=… POLYMATH_SPIKE_ACCOUNT=ca_… POLYMATH_SPIKE_TO=you@example.com \
  pnpm tsx scripts/spike-composio-write.ts
git status --porcelain scripts/   # empty: the script is deleted
```

The provider returns a message id, and the message is visible in the owner's
sent mail.

### Do not

- Send to anyone but the owner's own address.
- Log the API key, the connected-account id, or the response headers.
- Start Task 7 on a `GET`-only result without writing the fallback ticket.

---

## Task 2 — The capability catalog

**Files:** new `src/domains/integrations/capabilities.ts`; new
`tests/unit/capabilities.test.ts`.

### What changes

One module answers "what can a provider capability do, and under what limit".
The database's `integration_catalog.risk_by_capability` becomes display
metadata; no migration touches it and nothing reads it to gate.

```ts
export type Provider = "gmail";

export type CapabilitySpec = {
  provider: Provider;
  /** "read" runs inside a turn; "proposal" only ever creates a proposal. */
  kind: "read" | "proposal";
  riskClass: "read" | "external_write";
  tool: string;               // MCP tool name
};

export const CAPABILITIES = {
  "gmail.read":  { provider: "gmail", kind: "read",     riskClass: "read",           tool: "gmail_search" },
  "gmail.thread.read": { … , tool: "gmail_read_thread" },
  "gmail.send":  { provider: "gmail", kind: "proposal", riskClass: "external_write", tool: "gmail_send" },
} as const satisfies Record<string, CapabilitySpec>;

export type Capability = keyof typeof CAPABILITIES;

export const PROVIDER_TOOLS = …;        // tool name → capability, for dispatch
export const LIMITS = {
  defaultResults: 25,
  maxResults: 100,
  maxResponseBytes: 65_536,             // truncate with an explicit marker
  callsPerRunPerProvider: 50,
  callsPerWorkspacePerMinute: 60,
  effectsPerRun: 5,
} as const;
```

`tests/unit/capabilities.test.ts` pins the pairings that have burned this repo
before:

- every capability's `riskClass` equals `CAPABILITY_RISK[capability]` in
  `eve/alfred/evals/axiom-policy.ts`;
- `gmail.send` is `external_write` and `kind: "proposal"`;
- every `DEFAULT_ALLOWED_TOOLS` entry in `src/domains/agents/commands.ts` is
  either a known capability or an explicitly listed Polymath-native tool
  (`tasks.read`, `documents.search`, `wiki.*`);
- tool names are unique.

### Acceptance

```sh
pnpm exec vitest run --project unit tests/unit/capabilities.test.ts
pnpm typecheck
```

### Do not

- Add Linear, GitHub, Vercel, or Notion entries. Slices 2–4 own their rows.
- Move `gmail.read` / `gmail.send` names. They are already in
  `DEFAULT_ALLOWED_TOOLS` and in every profile's frozen snapshot; renaming is a
  migration with no benefit.

---

## Task 3 — The transport seam

**Files:** new `src/domains/integrations/transport.ts`; new
`tests/helpers/fixture-transport.ts`; new
`tests/fixtures/gmail/{search,thread,send,error}.json`; new
`tests/unit/transport.test.ts`.

### What changes

`transport.ts` is the only thing a read tool may call. Writes are not on it.

```ts
export type TransportRequest = {
  connectedAccountId: string;
  endpoint: string;                       // absolute https
  method: "GET" | "HEAD";
  query?: Record<string, string>;
  headers?: Record<string, string>;
};

export type TransportResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: "not_configured" | "provider_error"; status?: number; message: string };

export interface Transport { read(request: TransportRequest): Promise<TransportResult>; }

export const composioTransport: Transport; // wraps executeComposioRead
```

`executeComposioRead` keeps its read-only guard and its
`ComposioReadOnlyViolationError`; `composioTransport` adds the HTTP status to
`provider_error` so the gateway can tell 401 from 500.

`tests/helpers/fixture-transport.ts` exports
`fixtureTransport(routes: Array<{ method; endpointPrefix; status; body }>): Transport`.
It throws on an unmatched request — a fixture transport that silently returns
`{}` hides the bug the fixture exists to catch.

Fixtures are sanitised Gmail shapes: a `messages.list` page with two hits, a
`threads.get` with one multipart text/plain message, a `messages.send` success,
and a Gmail 401 error body. No real addresses, subjects, or ids.

### Acceptance

```sh
pnpm exec vitest run --project unit tests/unit/transport.test.ts tests/unit/composio-read.test.ts
pnpm typecheck
```

The transport test proves: a `POST`/`DELETE` never reaches `fetch`; 401 maps to
`provider_error` with `status: 401`; an unparseable body maps to
`provider_error`, not an empty success; the fixture transport throws on an
unmatched endpoint.

### Do not

- Add a write method to `Transport`. Writes live behind
  `src/domains/integrations/gmail/send.ts` (Task 7) and are unreachable from the
  gateway.
- Add retries inside the transport.

---

## Task 4 — Gateway token, route, and bindings

**Files:** new `src/domains/agents/gateway-token.ts`; new
`src/app/api/mcp/route.ts`; new `tests/unit/gateway-token.test.ts`; new
`tests/integration/mcp-gateway.test.ts`; `.env.example`.

### What changes

**`gateway-token.ts`** mirrors `src/domains/agents/bridge-token.ts` in shape and
differs in claims, secret, and audience:

- `EVE_GATEWAY_SECRET` (≥32 chars), **not** `EVE_BRIDGE_SECRET` (§6.1).
- Payload `{ rid, uid, wid, aud: "polymath-gateway", iat, exp, jti }`; `rid`
  (run id) is the primary claim, so a token is usable against one run only.
- TTL 60 s, 5 s clock skew, same `v1.<payload>.<sig>` base64url HMAC-SHA256.

Two files, not one parameterised signer: the claim sets and audiences differ,
and a shared signer invites a call site that passes the wrong secret. Add a
one-line comment saying so.

**`src/app/api/mcp/route.ts`** — `POST` only. JSON-RPC 2.0 over a single
request/response per call (stateless; no session id, no SSE in slice 1):

| JSON-RPC method | Behaviour |
|---|---|
| `initialize` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "polymath-gateway", version } }` |
| `notifications/initialized` | `204` |
| `tools/list` | the manifest from `PROVIDER_TOOLS` (Task 2) with zod→JSON Schema |
| `tools/call` | Task 6. In this task it returns a `method_not_found` error until Task 6 lands |

Every request runs the §5 bindings, in this order, before dispatch:

1. `Authorization: Bearer <token>` → `verifyGatewayToken`; invalid or expired →
   `401` problem+json (`problemResponse(401, "unauthorized", …)`).
2. Membership: new `activeMembershipRole(workspaceId, userId)` in
   `src/domains/identity/resolve.ts`; absent → `401`.
3. Run: select `agentRuns` by `(id = rid, workspace_id = token.wid)`; missing or
   foreign → `404` (same body for both, matching `getRun`).
4. Run owner: `run.createdBy !== token.uid` → `403`, unless the snapshot's
   `shared` flag is true (interpretation; see Open questions).
5. Run state: `run.state !== "running"` → `409`.
6. `x-polymath-session` header, when present, must equal `run.sessionRef`.

The run row is re-read on every call; no authorization result is cached across
calls (§5).

**`.env.example`** gains `EVE_GATEWAY_SECRET=` with a comment naming both
deployments that must hold it.

### Acceptance

```sh
pnpm exec vitest run --project unit tests/unit/gateway-token.test.ts
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/mcp-gateway.test.ts
pnpm typecheck
```

Unit: forged signature, wrong audience, expired `exp`, `exp - iat > 60`, and a
token minted with the bridge secret all return null. Integration: a valid token
for a running owned run returns the tool manifest; an expired token is 401; a
token naming another workspace's run is 404; a non-owner is 403; a cancelled run
is 409; `x-polymath-session` mismatch is 403.

### Do not

- Accept the bridge token. Different secret, different audience.
- Cache the run row, the membership, or the verdict anywhere.
- Return a different body for "missing run" and "another workspace's run".

---

## Task 5 — Gmail reads

**Files:** new `src/domains/integrations/gmail/reads.ts`; new
`tests/unit/gmail-reads.test.ts` (uses `tests/fixtures/gmail/*`).

### What changes

Pure functions over a `Transport`. No database, no policy — the gateway owns
those.

```ts
export type GmailMessageSummary = {
  id: string; threadId: string;
  from: string | null; subject: string | null; date: string | null;
  snippet: string | null;
};

export async function searchGmailMessages(
  transport: Transport,
  input: { connectedAccountId: string; query: string; limit: number; accountAlias?: string },
): Promise<{ ok: true; messages: GmailMessageSummary[] } | { ok: false; code: string; message: string }>;

export async function readGmailThread(
  transport: Transport,
  input: { connectedAccountId: string; threadId: string },
): Promise<{ ok: true; messages: Array<GmailMessageSummary & { bodyText: string | null }> } | { ok: false; … }>;
```

- Search: `GET …/users/me/messages?q=&maxResults=` with
  `format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`.
  Gmail `messages.list` returns ids only, so search follows with a bounded
  `messages.get` per hit at the same `maxResults` — at most 25 by default, 100
  hard.
- Thread: `GET …/users/me/threads/{id}?format=full`.
- Body: walk `payload.parts`, take `text/plain`, base64url-decode; fall back to
  `text/html` stripped of tags; otherwise `bodyText: null` rather than a guess.
- Parse every response with zod; a shape mismatch is `ok: false`, never a
  partial success.

### Acceptance

```sh
pnpm exec vitest run --project unit tests/unit/gmail-reads.test.ts
pnpm typecheck
```

Tests: two-hit search maps from/subject/date; an empty result is a success with
`messages: []`; a 401 surfaces `code: "provider_error"`; a malformed body is a
failure; a multipart thread yields text/plain; a metadata-only message yields
`bodyText: null`.

### Do not

- Send `format=raw` or fetch attachments.
- Retry a failed call inside this module.
- Let a model-supplied URL reach the transport. Endpoints are built here.

---

## Task 6 — Gateway dispatch: reads, proposals, limits, truncation

**Files:** new `src/domains/agents/gateway.ts`; `src/app/api/mcp/route.ts`;
`tests/integration/mcp-gateway.test.ts` (extended).

### What changes

`gateway.ts` exports `createGateway({ transport })` so tests inject a fixture
transport; the route uses the default `composioTransport`.

For every `tools/call`:

1. Resolve the tool → capability via `PROVIDER_TOOLS`. Unknown tool → `404`
   (`not_found`) without touching anything.
2. Parse arguments with a zod schema. `limit` is clamped to
   `1..LIMITS.maxResults`, default `LIMITS.defaultResults`.
3. Capability check: `toolAllowed(run.policySnapshot, capability)`. False →
   `403` and a recorded decision (step 7).
4. Account: `resolveConnectedAccount({ userId, workspaceId, role }, "gmail", alias)`
   from `src/domains/integrations/queries.ts`. Not connected, ambiguous, or
   revoked → `403`. This is the §8 live-state check.
5. Limits: count `tool_calls` rows for `(runId, toolName like 'gmail_%')` in the
   last unreserved window; at `LIMITS.callsPerRunPerProvider` → `429`
   `run_capability_limit`. Count workspace rows for the last 60 s at
   `LIMITS.callsPerWorkspacePerMinute` → `429` `workspace_rate_limit`.
6. Dispatch by `kind`:
   - **read**: call `searchGmailMessages` / `readGmailThread`; serialise; if the
     JSON exceeds `LIMITS.maxResponseBytes`, truncate to the last complete message
     and append `{ "truncated": true, "returnedBytes": n }`.
   - **proposal**: `createProposal(tx, …)` with capability, `riskClass:
     "external_write"`, `accountAlias`, `dedupeKey:
     gmail.mcp:${workspaceId}:${to}:${subject}:${inReplyTo ?? ""}`, `runId`; then
     insert `actionRevisions` number 1 with payload `{ to, subject, body,
     inReplyTo, accountAlias }` and preview `{ to, subject, body }` in the same
     transaction. Return `{ status: "awaiting_review", proposalId }`.
     **The revision row is required**: `decideProposal` rejects a proposal with
     no revision (`ProposalNotFoundError`), and today's `gmail_send` tool omits
     it — that is the second half of "proposals are created and never
     executed". Fixing it is in scope.
7. Record the decision: when `run.policySnapshot.grantId` is a string, load the
   grant, recompute `hashDelegationGrant` and call
   `decideAndRecordToolInvocation` from
   `src/domains/agents/authorization.ts`; a denial returns `403` and causes no
   effect. When no grant is present (every run made before grants are issued),
   the snapshot + bindings are the whole gate; the decision row cannot be written
   because `agent_authorization_decisions.grant_id` is `NOT NULL`. This gap is
   stated in the PR description and in Open questions.

### Acceptance

```sh
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/mcp-gateway.test.ts
pnpm exec vitest run --project unit tests/unit/tool-authorization.test.ts
pnpm typecheck
```

Integration proves, against Postgres with a fixture transport: a search returns
the fixture shape; `limit: 1000` clamps to 100; a capability missing from the
snapshot is 403 and nothing is fetched; a revoked account is 403 (after Task 9,
or by directly inserting `status='revoked'` here); `gmail_send` creates exactly
one proposal and one revision, returns `awaiting_review`, and the fixture
transport's fetch spy is never called; replaying the same send returns
`deduplicated: true` and one revision; the 51st call returns 429; a 70 KB result
comes back with `truncated: true`.

### Do not

- Add a tool for anything in slices 2–4.
- Return `"sent"` from any path. The only outcomes are `awaiting_review` and
  errors.
- Count limits from `agent_authorization_decisions` unless the grant gap is
  closed in the same change (see Open questions).

---

## Task 7 — Approved-effect executor and the approve→execute path

**Files:** new `src/domains/actions/attempts.ts`; new
`src/domains/actions/executor.ts`; new
`src/domains/integrations/gmail/send.ts`; `src/domains/actions/schema.ts`;
`src/domains/integrations/composio.ts`; new migration
`src/db/migrations/0222_action_attempt_idempotency.sql` and its
`meta/_journal.json` entry; `src/app/(workspace)/reviews/actions.ts`;
`src/app/(workspace)/reviews/reviews-queue.tsx`; new
`tests/integration/effect-executor.test.ts`.

### What changes

**Schema.** `action_attempts` gains `idempotency_key text not null` with a
unique index. This is the duplicate-send guard: the claim is one
`INSERT … status='unknown'` that loses the race on purpose (§4.2 step 5). The
existing `(proposal_id, attempt_number)` index stays.

```sh
DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm db:generate --name action_attempt_idempotency
# review the generated SQL; ensure the journal entry exists
pnpm check:migrations main
```

**`attempts.ts`** — shared by the executor and Calendar:

```ts
export async function claimAttempt(tx, input: {
  workspaceId; proposalId; revisionId; idempotencyKey; attemptNumber;
}): Promise<{ attemptId: string }>;            // throws AttemptAlreadyClaimedError on 23505
export async function settleAttempt(tx, input: {
  attemptId; outcome: "succeeded" | "failed" | "unknown"; providerObjectId?;
  errorCode?; responseSummary?;
}): Promise<void>;
```

**`gmail/send.ts`** — `sendGmailMessage({ connectedAccountId, to, subject, body,
inReplyTo, attemptId })`. Builds RFC 2822 with a stable marker
`Message-ID: <polymath-${attemptId}@polymath.invalid>` (derived from the attempt
id, never stored separately), base64url-encodes, and calls the proxy with
`POST …/messages/send`. It throws `GmailSendAmbiguousError` on timeout, 5xx, or
an unparseable 200; a 4xx before dispatch throws `GmailSendRejectedError`
carrying the status. `executeComposioWrite(call)` is added to
`src/domains/integrations/composio.ts` for this call only.

**`executor.ts`** — `executeApprovedEffect(auth, { proposalId }): Promise<EffectOutcome>`
with the shape from §4.4:

1. Re-read proposal, newest revision, latest review. Not approved, or
   `review.revisionId !== newestRevision.id` → `StaleRevisionError`.
2. Re-verify the capability now: the proposal's `runId`, when set, must still be
   in a non-terminal state and its frozen `policySnapshot.allowedTools` must
   contain the capability. A cancelled run refuses.
3. Re-verify the account: `resolveConnectedAccount(…, "gmail", proposal.accountAlias)`;
   not active → `SendNotAllowedError`.
4. Cap: count attempts joined to proposals with the same `runId`; at
   `LIMITS.effectsPerRun` → `EffectBudgetExceededError`.
5. Claim: `claimAttempt(…, idempotencyKey: "exec:" + proposalId, attemptNumber: prior+1)`.
   `AttemptAlreadyClaimedError` → return the existing attempt's settled outcome;
   if it is still `unknown`, return `{status:"unknown"}` and never call the
   provider. A prior `succeeded` or pending-unknown attempt blocks a new claim.
6. Call `sendGmailMessage` **outside** any transaction.
7. Settle in one transaction with `recordAudit` (`actions.effect_sent` /
   `actions.effect_failed` / `actions.effect_unknown`). No outbox event; nothing
   consumes one.
8. Return `{status:"sent", providerId, at}` / `{status:"failed", reason,
   retryable}` / `{status:"unknown", reconciliationId: attemptId}`.

Capability routing is a literal map with one entry: `gmail.send`. Anything else
throws `EffectNotSupportedError` — no default branch that guesses.

**Reviews.** `decideProposalAction` in
`src/app/(workspace)/reviews/actions.ts` calls `decideProposal`, then, when the
decision is `approved` and the capability has an executor, calls
`executeApprovedEffect`. It returns `{ ok: true, outcome }`. `ProposalConflictError`
from a retry falls through to the executor, as `approveCalendarProposal` does.
`reviews-queue.tsx` renders one line from `outcome`:

| outcome | copy |
|---|---|
| `sent` | `Sent.` |
| `unknown` | `Checking whether this was sent.` |
| `failed` | `Not sent. <reason>` — never the word "retry" |

### Acceptance

```sh
pnpm check:migrations main
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/effect-executor.test.ts
pnpm typecheck
```

Integration proves: one approve sends once; a second `executeApprovedEffect` on
the same proposal returns the settled outcome and the spy count stays 1; a
crash-shaped attempt (`status='unknown'`) blocks a second claim; evolving the
payload after approval (`reviseProposal`) makes the decision stale (`StaleRevisionError`);
a revoked account refuses before any call; a timeout settles `unknown` and the
proposal is not re-approvable into a send; a 400 settles `failed` with
`retryable: false`; six approved effects in one run hits the cap.

### Do not

- Execute from a tool, a prompt, or a gateway call.
- Hold a transaction across `sendGmailMessage`.
- Mark the proposal `sent`; the proposal stays `approved` and the attempt carries
  the outcome.
- Add a generic "effect" abstraction with one implementation.
- Say "Failed, retry" anywhere in the UI.

---

## Task 8 — Reconciliation settles unknown attempts

**Files:** new `src/domains/actions/reconciliation.ts`;
`src/app/api/internal/cron/route.ts`; new
`tests/integration/reconciliation.test.ts`.

### What changes

`reconcileUnknownAttempts({ transport, now, limit = 20 })`:

1. Select `action_attempts` where `status='unknown' and reconciliation='pending'`,
   oldest first, using the existing `action_attempts_unresolved_idx`.
2. Resolve the proposal's capability and the attempt's marker
   (`polymath-<attemptId>@polymath.invalid`).
3. For `gmail.send`, search Gmail with
   `q=rfc822msgid:<marker>` through the transport.
4. Settle: a hit → `succeeded`, `providerObjectId`, reconciliation `resolved`,
   plus a `provider_observations` row with `observedState: "sent"`. No hit **and**
   the attempt is at least 10 minutes old → `failed`, reconciliation `resolved`,
   observation `"absent"`. No hit and younger than 10 minutes → leave `unknown`
   (Gmail's index lags; absence is not proof yet — an interpretation, flagged).
   Transport error → leave unchanged; do not settle on a guess.
5. `recordAudit` on every settle, in the same transaction. Gmail has no
   observation for an unresolved attempt.

`POST /api/internal/cron` calls it after `dispatchPendingOutbox` and returns
`{ reconciled: n }` alongside its current body. Same `OUTBOX_DISPATCH_SECRET`
gate; no new endpoint.

### Acceptance

```sh
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/reconciliation.test.ts
pnpm exec vitest run --project unit tests/unit/cron-route.test.ts
```

Tests: a found message settles `succeeded` with the provider id; an absent
message older than 10 minutes settles `failed`; an absent message younger than
10 minutes stays `unknown`; a transport error leaves the row untouched; a
`succeeded` attempt is not selected; the cron route reports `reconciled`.

### Do not

- Retry the send from reconciliation.
- Settle `failed` from a single absence inside the lag window.
- Settle on a transport error.

---

## Task 9 — Revoke a connected account

**Files:** `src/domains/integrations/commands.ts`;
`src/app/(workspace)/command-center/integrations/actions.ts`;
`connector-controls.tsx` / `connector-catalog.tsx`; new
`tests/integration/connected-account-revocation.test.ts`.

### What changes

`setAccountStatus` already accepts `"revoked"`; nothing calls it with that
value. Add `revokeConnectedAccount(auth, { accountId, expectedVersion })` as the
named command (a thin wrapper that refuses a `connecting` row and delegates),
and a `revokeAccountAction` server action behind `requireRole(auth, "admin")`.
The connector card gets a **Disconnect** control with a one-line confirmation;
revoked accounts render `Disconnected` and offer "Register a new alias" (matching
`beginConnection`'s refusal to reuse a revoked alias).

Revocation takes effect because every read (`resolveConnectedAccount`) and every
send (executor step 3) checks `status = 'active'` live, per call.

### Acceptance

```sh
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/connected-account-revocation.test.ts \
  tests/integration/connected-account-resolution.test.ts
pnpm typecheck
```

Tests: revoking flips status and writes `integration.account_revoked` audit;
`resolveConnectedAccount` then returns `not_connected`; a stale version throws
`StaleWriteError`; revoking an already-revoked row is idempotent; a `failed`
executor run against a revoked account makes no provider call.

### Do not

- Delete the row. Revocation is a lifecycle state, not a delete.
- Call Composio to revoke the connection remotely. Slice 1 stops Polymath from
  using it; the provider-side revoke is out of scope.

---

## Task 10 — Calendar gets the same enforcement

**Files:** `src/domains/calendar/proposals.ts`;
`tests/integration/calendar-proposal-execution.test.ts` (new; keep
`tests/integration/calendar-blocks.test.ts` green).

### What changes

Three checks inside `approveCalendarProposal`'s `execute()`, before the calendar
command runs:

1. **Capability still allowed.** Read the proposal's `runId` snapshot with
   `getRunPolicySnapshot(runId, workspaceId)`; require the capability
   (`calendar.block` / `calendar.event.create` / `calendar.event.move` /
   `calendar.event.cancel`) to still be in `allowedTools` and the run not
   terminal. Proposals without a run (a person created them) skip this check.
2. **Account still active.** When `actionProposals.accountAlias` is set, resolve
   it through `resolveConnectedAccount` and require `active`. Calendar proposals
   set no alias today because the event is local; the check therefore does
   nothing until a proposal names an external account. This is the honest reading
   of §9 rather than inventing an account link.
3. **Attempt row.** Use `claimAttempt` / `settleAttempt` from
   `src/domains/actions/attempts.ts` with `idempotencyKey:
   "calendar-exec:" + proposalId`. `blockTimeForTask`/`createEvent`/… keep their
   existing `calendar-exec:<proposalId>` command key, so a retry after a crash is
   still a no-op; the attempt row makes the outcome visible and blocks retries
   while it is unknown.

`execute()` now returns the attempt outcome and `approveCalendarProposal`
returns it rather than `{ executed: true }`; update
`src/app/(workspace)/neuralflow/work/calendar-actions.ts` and any caller.

### Acceptance

```sh
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/calendar-proposal-execution.test.ts \
  tests/integration/calendar-blocks.test.ts
pnpm typecheck
```

Tests: removing the capability from the run's snapshot after approval refuses
the execute; a cancelled run refuses; a named, revoked account refuses; the
attempt row records the outcome; a replay after a crash does not double-book
(assert one event row).

### Do not

- Route Calendar through the MCP gateway. It stays a server action (§9).
- Change the calendar commands or their idempotency keys.
- Invent an external account link for local events.

---

## Task 11 — Eval guards, all three, fail closed

**Files:** new `eve/alfred/evals/stubs.ts`; new
`eve/alfred/evals/network-guard.ts`; `eve/alfred/evals/chat-grounding.eval.ts`;
new `tests/unit/eval-stub-coverage.test.ts`.

### What changes

**1. No credentials.** `stubs.ts` exports `assertEvalEnvironment()`: throws when
`COMPOSIO_API_KEY`, `FIRECRAWL_HOSTED_API_KEY`, or `GEMINI_API_KEY`-adjacent
provider keys beyond the model are set. Each eval module calls it at import time;
a misconfigured eval fails before a turn starts.

**2. Network block.** `network-guard.ts` exports `installNetworkGuard()` which
replaces `globalThis.fetch` with a wrapper that allows only
`generativelanguage.googleapis.com` (the model) and throws
`EvalNetworkViolation: <host> (tool: <toolName>)` for anything else. The tool
name comes from the guard's per-call label, set by the harness around a stubbed
session. `chat-grounding.eval.ts` calls it inside `test()` before `t.session`.

**3. Stub completeness.** `stubs.ts` holds one `STUBBED_TOOLS` list, consumed by
every eval's `quietStubs()`. `tests/unit/eval-stub-coverage.test.ts` reads
`eve/alfred/agent/tools/*.ts` filenames, converts each to its registered tool
name, and fails when one is absent from `STUBBED_TOOLS`. This is the check that
would have caught the real-inbox read.

Because `eve`'s stub layer calls the real tool when no stub matches
(`tool-stubs/execute.js`), the test is the only static guard; the other two are
runtime.

### Acceptance

```sh
pnpm exec vitest run --project unit tests/unit/eval-stub-coverage.test.ts
pnpm typecheck
```

Prove the guard bites: temporarily create
`eve/alfred/agent/tools/__coverage_probe.ts`, confirm the test fails naming it,
delete the file, confirm green. Record both outputs in the PR description.

### Do not

- Rely on the stub list alone.
- Allow any host besides the model endpoint in the guard.
- Put eval-only code in `src/`.

---

## Task 12 — Wire eve to the gateway and retire the URL proxy

**Files:** new `eve/alfred/agent/connections/polymath_gateway.ts`;
delete `eve/alfred/agent/tools/connected_read.ts` and
`eve/alfred/agent/tools/gmail_send.ts`; `eve/alfred/agent/instructions.md`;
`eve/alfred/evals/stubs.ts`; delete
`tests/unit/connected-read-capabilities.test.ts` and
`tests/unit/connected-read-grant.test.ts`; trim the gmail cases in
`tests/unit/eve-tools.test.ts`; `.env.example`; `agents/architecture.md`
(tool list).

### What changes

```ts
// eve/alfred/agent/connections/polymath_gateway.ts
import { defineMcpClientConnection } from "eve/connections";
```

- `url`: `process.env.POLYMATH_GATEWAY_URL` (absolute; the app origin in a
  deployment).
- `description`: "Polymath provider gateway: Gmail search, thread read, and send
  proposals."
- `auth: (ctx) => ({ credentialOwner: "app", getToken: async () => ({ token: mint(ctx) }) })`.
  `mint` reads `workspaceId` from `ctx.session.auth.current.attributes`,
  resolves the run with `getRunBySessionRef(ctx.session.id, workspaceId)`,
  and signs `signGatewayToken({ runId, userId, workspaceId })` with
  `EVE_GATEWAY_SECRET`. No run → throw `ConnectionAuthorizationRequiredError`
  so the turn fails loudly rather than calling the gateway anonymously.
- `headers: (ctx) => ({ "x-polymath-session": ctx.session.id })`.
- `tools: { allow: ["gmail_search", "gmail_read_thread", "gmail_send"] }`.

Delete both authored tools. Their capabilities stay in
`DEFAULT_ALLOWED_TOOLS`; the gateway reads the snapshot. Update
`instructions.md` if it names `connected_read` or `gmail_send` as authored
tools; the agent now reaches them through the connection.

The eval stub list replaces `connected_read`/`gmail_send` with the three MCP
tool names (eve stubs MCP tools by their exposed name; verify on the first
`eve eval` run and adjust `STUBBED_TOOLS` if the names are prefixed).

`tests/unit/eve-tools.test.ts` keeps its `tasks_read` cases and drops the gmail
proposal cases (now proven by `tests/integration/mcp-gateway.test.ts`).

### Acceptance

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm exec vitest run --project unit tests/unit/eval-stub-coverage.test.ts
```

Manual, with `eve dev` and the app running: "What did Priya say about the
contract?" calls `gmail_search` and answers with subject, sender, and date; "Send
Priya a note confirming Thursday" creates a proposal that appears in `/reviews`,
and no message is sent until the owner approves it there.

### Do not

- Keep `connected_read` as a fallback. The spec supersedes it.
- Give the connection a Composio key or any provider credential.
- Mount the gateway for the `specialist` agent in this slice.

---

## Out of scope

- **Slice 2:** Linear read (`linear_read_issues`). `linear_read_cycle` is cut
  permanently.
- **Slice 3:** GitHub read (pulls, checks).
- **Slice 4:** Vercel read (deployments, logs).
- **Deferred, their own design:** Vercel deploy/rollback, Notion, Canva.
- A generic effect abstraction, a workflow engine, or a queue for effects.
- Approvals UI redesign; a dedicated surface for unknown outcomes (the spec's
  §15 Q2).
- Remote revocation at Composio.
- Bank-grade asymmetric gateway signing (`§6` residual risk is recorded, not
  fixed).
- Changes to `agents/*.md` beyond the tool list in `architecture.md`.

---

## Open questions for the implementer

These are places where the spec is silent, ambiguous, or contradicts the code.
Each has a chosen interpretation above; confirm rather than discover.

1. **Composio writes** — Task 1 decides the shape of Task 7. If it fails, the
   fallback is a direct Google API call with a token from Composio.
2. **MCP transport** — the spec says "Streamable HTTP" but does not require
   sessions or SSE. This plan uses stateless JSON-RPC. Verify eve's MCP client
   connects; if it requires a session id, add one header rather than a state
   store.
3. **Limit accounting (§10)** — the spec counts per-run calls from
   `agent_authorization_decisions`, but that table's `grant_id` is `NOT NULL` and
   most runs have no grant. This plan counts `tool_calls` instead. Either accept
   that or make the decision log's grant nullable in a migration.
4. **Grant authorization (§5 / §15 Q4)** — `authorizeToolInvocation` is wired
   only when the run snapshot names a grant. Where are grants issued for chat
   runs? Until that exists, the check protects nothing in practice; say so in the
   PR.
5. **Run owner (§15 Q3)** — `run.createdBy === token.uid`, unless the snapshot
   has `shared: true`. No `shared` field exists today, so every run is personal.
6. **Outcome surface (§15 Q2)** — one status line on the Reviews card. Unknown
   deserves a better affordance; that is a separate ticket.
7. **Calendar's "connected account" (§9.2)** — calendar proposals are local and
   carry no alias. The check is conditional and does nothing today. Confirm that
   is acceptable, or define which account a synced-calendar write names.
8. **Absence-proof window** — 10 minutes before a "not found" settles `failed`.
   This number is invented; pick it from Gmail's observed index lag.
9. **`gmail_send` had no revision** — the existing tool creates proposals that
   can never be approved. Task 6 fixes it for the gateway; existing rows are not
   backfilled.
10. **Effect cap for human proposals** — `LIMITS.effectsPerRun` applies to
    proposals with a `runId`; a person-made proposal has none and is uncapped.
    Confirm.
