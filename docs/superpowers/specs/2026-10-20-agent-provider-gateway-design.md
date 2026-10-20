# Agent provider gateway — design (revision 2)

**Status:** design, revised after review 2026-10-20. Not yet planned into tickets.
**Supersedes:** revision 1 of this file, and the `connected_read` URL proxy in the
eve agents backend foundation design.

Revision 2 exists because revision 1 designed **how the agent asks** and left
**what happens after a human says yes** as an exercise. That is the dangerous
half. The review's six findings are addressed in §4, §5, §6, §7, §8, and §9; the
scope is narrowed in §11.

---

## 1. What this is, in one paragraph

The agent today reaches connected services through one tool that takes a URL and
fetches it, and it cannot complete a single external write: Gmail proposals are
created correctly and then die on a sender that throws by design. This design
replaces the URL proxy with a **gateway**: one place that decides whether a
capability is allowed, and one place that executes an approved external effect.
The agent never holds a provider credential; the approved-effect executor is the
only code that calls a provider to write.

```
eve (reasoning)                     no provider credentials
   │  MCP connection, per-call token
   ▼
/api/mcp  (the gateway)             authorization checkpoint
   │
   ├── typed provider tools         linear_read_issues, gmail_search, …
   │      └── Transport
   │           ├── composioRead      production reads
   │           └── fixtureTransport  local + CI (and the only one in tests)
   │
   └── Polymath-native tools        tasks_read, documents_search
   ▲
   │  approved effects, from outside any turn
   │
Effect executor                      the only writer
```

---

## 2. Verified facts, and what is assumption

Separated deliberately: the review is right that a design document that mixes
them is hard to trust.

### Verified in this repository (2026-10-20)

| Fact | Evidence |
|---|---|
| `connected_read` is a generic URL proxy, host+path allowlisted | `eve/alfred/agent/tools/connected_read.ts` |
| Gmail proposals are created but never executed | `eve/alfred/agent/tools/gmail_send.ts` creates a proposal; `src/domains/crm/send-executor.ts:43` `unconfiguredSender` throws |
| Calendar has a working end-to-end executor | `src/domains/calendar/proposals.ts:121` `approveCalendarProposal` → `execute` |
| `decideProposal` does not execute | `src/domains/actions/commands.ts:81` — "Nothing here executes" |
| `authorizeToolInvocation` / grant-based authorization is **never called** | no references outside `authorization.ts` |
| Composio exposes a read-only executor; there is no write path | `src/domains/integrations/composio.ts:127` `executeComposioRead` only; writes throw |
| Composite FK enforces account belongs to workspace | `src/domains/integrations/schema.ts` |
| Eve eval stubs **fall through to the real tool** when no stub matches | `node_modules/eve/dist/src/tool-stubs/execute.js` — `i===void 0?r():…` calls the real executor |
| No rate limiting on provider calls | no `rateLimit`/`throttle` in `src/domains/integrations` |
| No revoke/expire command for connected accounts | `account_status` enum has `revoked`; nothing sets it |
| eve supports `deferred` tools and MCP client connections | `eve@0.76.3` public types |

### Assumption, not verified

- Composio's proxy will accept a `POST` through a connected account for a given
  provider. Revision 1 assumed it; `executeComposioRead` only proves `GET`.
  **Gmail send must be proven against the proxy before the write slice is
  planned.** If it fails, the write executor calls the Google API directly with
  a token from Composio's connected-account endpoint, and that becomes its own
  ticket.
- Vercel, Linear, and GitHub APIs behave as their public docs describe. No
  provider call has been made from this repo.

---

## 3. Scope, narrowed

Revision 1 proposed four providers at once. That was wrong: the hard part is not
adding providers, it is making **one write path** correct.

| Slice | Content | Ships when |
|---|---|---|
| **1** | Gmail read + **complete approved send**, end to end | The whole executor, retry, and reconciliation story is proven |
| **2** | Linear read (`read_issues`, `read_cycle`) | Slice 1 is merged |
| **3** | GitHub read (pulls, checks) | Slice 2 is merged |
| **4** | Vercel **read only** (deployments, logs) | Slice 3 is merged |
| **deferred** | Vercel deploy/rollback, Notion, Canva | Vercel's blast radius and recovery are specified separately |

Vercel writes are deferred specifically because a deploy is the first
irreversible action in the system, and its approval card, rollback semantics, and
uncertainty handling deserve their own design rather than a row in a table.

---

## 4. The approved-effect executor

This is the section revision 1 was missing. It is the core of the design.

### 4.1 Who executes

`src/domains/actions/executor.ts`, called only from a route handler or a
workflow step — **never from inside an agent turn**. Three callers:

1. The reviews screen's approve action, which approves *and* executes in one
   request (as `approveCalendarProposal` does today).
2. A reconciliation job that settles `unknown` attempts.
3. Nothing else. There is no tool, prompt, or agent path to it.

### 4.2 The sequence

```text
approve(proposalId, expectedVersion, revisionId)
  → decideProposal(...)                        [existing]
  → executor.execute(proposalId)
      1. re-read the proposal, its newest revision, and the latest review
      2. verify the review's revisionId === newest revision   (content binding)
      3. re-verify the capability is still granted *now*       (§8)
      4. re-verify the connected account is still active *now*  (§8)
      5. claim an attempt row: INSERT action_attempts
           (status='unknown', idempotency_key = exec:<proposalId>)
         UNIQUE(idempotency_key) makes this the single claim
      6. call the provider
      7. settle the attempt: sent | failed | unknown
      8. record audit, in the same transaction as the settle
```

**Step 5 is the duplicate-send guard.** An attempt row is written as `unknown`
*before* the provider call. A crash between 5 and 7 leaves an unsettled attempt,
which blocks a retry (step 5's unique index rejects it) until step 3 of
reconciliation resolves it. That is the existing rule in
`src/domains/crm/send-executor.ts` — reuse its shape, do not invent a second
one.

### 4.3 Retry and uncertainty

| State | Meaning | Next action |
|---|---|---|
| `sent` | provider returned a message id | terminal |
| `failed` | provider proved non-delivery (4xx before dispatch) | a new proposal may be created |
| `unknown` | timeout, 5xx, connection reset, or a malformed body | **never retried automatically**; reconciliation reads the provider |

Reconciliation asks the provider "did this arrive?" using the idempotency marker
the executor attached (a `Message-ID` header for Gmail). If the provider confirms
delivery, settle `sent`. If it proves absence, settle `failed` and the proposal
may be re-approved. If it cannot tell, it stays `unknown` and the UI says so.

**The UI never says "Failed, retry" for an unknown outcome.** It says "Checking
whether this was sent." That is a product rule from `agents/product.md` first
principles #9.

### 4.4 Truthful status

The executor returns a value the UI renders directly:

```ts
type EffectOutcome =
  | { status: "sent"; providerId: string; at: Date }
  | { status: "failed"; reason: string; retryable: boolean }
  | { status: "unknown"; reconciliationId: string }
```

An agent turn that creates a proposal reports `awaiting_review`. It must never
report having sent anything. The eval in §7 asserts exactly this.

---

## 5. The authorization boundary

Revision 1 checked "is this session in this workspace". The review is right that
this is too loose. Every gateway call is bound to **five** things:

| Binding | Check | Failure |
|---|---|---|
| Token | HMAC valid, `exp` not passed | 401 |
| Principal | `token.uid` is an active member of `token.wid` | 401 |
| Run | `x-polymath-session` resolves to a run in `token.wid` | 404 |
| **Run owner** | `run.createdBy === token.uid` unless the run is a workspace-shared profile | 403 |
| Run state | run is `running` (or the call is an approval-context read) | 409 |
| Capability | in `run.policySnapshot.allowedTools` | 403 |
| Account | the named alias belongs to this workspace **and** is `active` | 403 |
| Resource | if the tool takes a `resourceRef`, it is in the grant's `allowedResources` | 403 |

**Concurrent runs.** Each run has its own frozen snapshot and its own session,
so two concurrent runs cannot share a capability decision. The gateway never
caches an authorization result across calls — it re-reads the run row per call.
The cost is one indexed read; the benefit is that a cancelled run stops working
immediately rather than at the end of a token's life.

**Fork-capability grants.** `authorizeToolInvocation` (the grant-narrowing check
that exists but is never called) becomes part of this path, at least for
delegated runs. If wiring it now proves larger than one slice, it is recorded as
a known gap with an explicit ticket, not silently omitted — a check that exists
and is unused is worse than no check, because it reads as protection.

---

## 6. The signing secret

Honest assessment: the original design had **eve holding a secret that mints
workspace identity**, and called that "no new secret", which is not a trust
argument.

What changes:

1. **A separate secret.** `EVE_GATEWAY_SECRET`, not `EVE_BRIDGE_SECRET`. The
   bridge secret authenticates users *to* eve; the gateway secret authenticates
   eve *to* the gateway. Compromising one does not grant the other.
2. **The gateway token carries a run id**, not a workspace id, as its primary
   claim. A minted token is therefore only usable against the run it names.
3. **A 60-second TTL**, unchanged. Replies cannot be recorded and replayed later.
4. **The gateway refuses a token whose run is not `running`.**

Residual risk, stated plainly: **an attacker who compromises the eve runtime can
mint a gateway token for any run id it can guess or read.** Mitigations bound the
damage — the run must exist, be running, and the token cannot name an arbitrary
workspace — but they do not eliminate it. The durable fix is asymmetric signing
(gateway holds the private key, eve verifies nothing) or platform workload
identity, and both are larger than this design. Recorded as a known limitation.

---

## 7. Test isolation must fail closed

**Verified**: eve's stub layer calls the real tool when no stub matches
(`tool-stubs/execute.js`). Revision 1's "stub every tool" is a convention that a
newly added tool silently breaks — and the repo has already been burned by it
(`chat-grounding.eval.ts`'s comment describes an eval that read a real inbox).

Three layers of defence, in order:

1. **No credentials in the test environment.** The eval job runs with no
   `COMPOSIO_API_KEY`. A real provider call cannot authenticate. This is the
   only guard that does not depend on anyone remembering anything.
2. **A network block.** The eval harness installs a `fetch` interceptor that
   throws on any host outside the model provider. An escaped call fails loudly
   and names the tool.
3. **A stub-completeness assertion.** `tests/unit/eval-stub-coverage.test.ts`
   enumerates the agent's tool modules and the stub list each eval declares, and
   fails when a tool exists that no eval stubs. This is the check that would have
   caught the inbox read.

All three. Any one alone is a convention.

---

## 8. Live state beats the frozen snapshot

`agents/coding.md` says a run's policy snapshot is authoritative. The review is
right that this cannot mean "authoritative forever": a connected account
disconnected at 10am must stop working at 10:01am.

Resolution, and it is not a contradiction:

- **The snapshot bounds what the run may ever do.** It never widens.
- **Live state may narrow it further.** Before every provider call the gateway
  re-reads the account row and requires `status = 'active'`. Before every
  approved effect the executor re-reads the grant and the account.
- A disconnected account, a revoked grant, or a finished membership therefore
  stops the work immediately, and the run reports why.

This needs `revokeConnectedAccount` / `disconnect` commands, which **do not
exist today** (`account_status` has a `revoked` value and nothing sets it). That
is part of slice 1, not a follow-up: a revocation path that cannot be exercised
is untested security.

---

## 9. Calendar gets equivalent enforcement

Calendar is the one working write path and it does **not** go through the
gateway. Leaving it as-is would make "one policy checkpoint" false.

It does not need to be rewritten. It needs the same **enforcement**, which is
three checks it does not currently perform:

1. Re-verify the capability is still allowed at execution time, not only at
   proposal time.
2. Re-verify the connected account is `active` at execution time.
3. Write the attempt row and settle it — `execute()` in
   `src/domains/calendar/proposals.ts` currently calls the provider and returns
   without the unknown-state protection the CRM sender has.

Three edits to an existing file, plus its tests. Done in slice 1 because it is
small and because the gateway's claim is only true once it holds.

---

## 10. Limits

Revision 1 had none. A provider call needs:

| Limit | Where | Value |
|---|---|---|
| Results per call | tool schema `limit` | max 100, default 25 |
| Response bytes to the model | gateway, after the call | truncate at 64 KB with an explicit "truncated" marker |
| Calls per run per provider | gateway, counted from `agent_authorization_decisions` | 50; exceeding parks the run for review |
| Calls per workspace per minute | gateway | 60 |
| Approved external effects per run | executor | 5; more needs a new run |

The run budget (`spending_reservations`) already bounds model spend. These bound
*provider* spend and blast radius, which is a different axis. None of them apply
to fixture transport, where there is nothing to protect.

---

## 11. Provider catalog — corrected

Revision 1 listed Notion tools in the table and then deferred Notion in the text.
That was contradictory. The catalog now says what actually ships.

| Provider | Read | Write | Status |
|---|---|---|---|
| **Gmail** | `gmail_search`, `gmail_read_thread` | `gmail_send` (approved effect) | **slice 1** |
| **Linear** | `linear_read_issues` | — | slice 2 |
| **GitHub** | `github_read_pulls`, `github_read_checks` | — | slice 3 |
| **Vercel** | `vercel_list_deployments`, `vercel_read_logs` | — | slice 4 |
| **Calendar** | existing path | existing path, hardened (§9) | slice 1 |
| **Vercel** writes | — | — | deferred, own design |
| **Notion** | — | — | deferred; an importer already covers it |
| **Canva** | — | — | deferred; nothing in v1 asks for it |

Capability vocabulary lives in one module,
`src/domains/integrations/capabilities.ts`. The database's `risk_by_capability`
column becomes display metadata; it no longer gates anything.

**One read path is deferred with a reason**: `linear_read_cycle` is cut. "What's
in this cycle" is answered by `linear_read_issues` filtered by cycle, and a
second query shape earns nothing.

---

## 12. Provider stories — corrected

### Gmail

**Read.** *"What did Priya say about the contract?"* → searches, finds the
thread, answers citing **subject, sender, and date**. No match → says so.

**Write.** *"Reply to Priya and confirm Thursday."* → a proposal with recipient,
subject, body, and the message it replies to. Approval binds to that exact
revision; editing the body invalidates it. On approval the effect executor sends.

**Why the approval is required — corrected.** Revision 1 said sending is
"reversible in the social sense". It is not. An email cannot be recalled
reliably; it may be read, forwarded, or acted on within seconds. Approval is
required because **delivery is irreversible and the recipient is outside the
workspace's control** — recipient, content, and sensitivity decide this, not any
idea of social undo.

### Linear

**Read.** *"What's blocking the release?"* → reads issues in the release's scope
and reports blockers. **Corrected:** in-progress state is not blocking, and a
title match is not a dependency. Blocking is a relation, so the tool returns
`blockedBy` relations and the story names the release scope explicitly. If the
workspace has no release object, the answer says "blocked issues in this team"
rather than pretending to know the release.

### GitHub

**Read.** *"Why is the CI red on my branch?"* → lists pull requests, reads checks
for the current one, and reports **which job failed and its first error line**.
"Never ran" and "failed" are reported as different answers.

### Vercel

**Read.** *"Is the deploy for branch x healthy?"* → deployment state, then logs.
**Corrected:** deployment logs prove a build ran; they do not prove the
application is healthy. The answer separates **deploy state** (ready / error /
building) from **runtime health** (unknown unless a health signal exists), and
says the second part is unknown rather than implying success.

---

## 13. The gateway, briefly

`POST /api/mcp`, Streamable HTTP, one route:

1. Verify the bearer (§5, §6) → `{ uid, wid, runId }`.
2. Resolve the run; check owner, state.
3. Look up capability → risk class.
4. `read` → transport → truncate → return.
5. `external_write` / `sensitive_write` → create the proposal, return
   `awaiting_review`. **Never call a provider.**
6. `prohibited` / unknown → 403.
7. Record the decision.

Tools are `deferred: true` so the model finds them with `eve__search`; only
`tasks_read` and `documents_search` are always materialised. The reason is
measured: `docs/context-optimization.md` records 521 KB of tool schemas per turn
when the catalog got large.

---

## 14. Testing

| Layer | What it proves | Needs |
|---|---|---|
| Unit | each tool's endpoint, parsing, and refusal paths | fixture transport |
| Gateway integration (real Postgres) | bindings in §5, proposal-not-call in step 5, revocation in §8 | Postgres, no network |
| Executor integration (real Postgres) | claim-once, unknown-state blocks retry, reconciliation settles, content binding | Postgres + a fake provider |
| Agent evals | the agent looks before answering, cites, and never claims to have acted | live model, stubs, §7's three guards |

Each layer tests one thing; none of them touch a network or a real account.

---

## 15. Open questions

1. **Does the Composio proxy accept writes?** The one assumption that can
   invalidate slice 1's shape. Prove it before planning the write.
2. **Where does the send outcome surface?** The reviews queue is the natural
   place, but an `unknown` outcome needs a different affordance than an
   approve/reject row.
3. **Should the run owner check be `createdBy` equality or a role check?** A
   shared run (a team-owned profile) is a legitimate case the current schema does
   not distinguish.
4. **Is wire-level grant authorization in slice 1 or its own ticket?** §5 says
   decide; it should be decided when slice 1 is planned, not deferred silently.
