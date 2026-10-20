# Agent provider gateway — design

**Status:** design, approved 2026-10-20. Not yet planned into tickets.
**Supersedes on tool surface:** the `connected_read` URL proxy described in the
eve agents backend foundation design.

---

## 1. The short version

Today the agent can talk to three connected services (Gmail, Calendar, Notion)
and only through one blunt instrument: a tool that takes a URL and fetches it.
It can propose sending an email but nothing can actually send it. Four of the
seven services the product advertises — GitHub, Linear, Vercel, Canva — have no
agent access at all. Calendar is the one path that reaches all the way to a
real external effect.

This design replaces the URL proxy with a **contract**, not a bigger tool list:

```
eve (the agent)                  no provider credentials, ever
   │
   │  one MCP connection, authenticated per call
   ▼
/api/mcp  (the gateway)          the only door
   │
   ├── typed provider modules    linear_read_issues, gmail_search, …
   │      └── transport seam
   │           ├── composioHttp       production: token stays in Composio
   │           └── fixtureTransport   local + CI: JSON files
   │
   └── Polymath-native tools     tasks_read, documents_search
```

Three properties fall out of this shape:

1. **The agent never holds a provider credential.** eve authenticates to our
   gateway and nothing else. Composio keeps the OAuth tokens.
2. **Policy is enforced in one place.** The gateway is where a capability is
   checked against the run's frozen snapshot, and where a write becomes a
   proposal instead of a call.
3. **Tests cannot touch a real account.** The transport seam swaps the network
   for JSON files, so local dev, CI, and evals all run against the same
   fixtures.

---

## 2. Why not the obvious alternative

`eve@0.76.3` ships `defineOpenAPIConnection`, which turns an OpenAPI document
into tools automatically. For GitHub and Vercel that is close to zero code, and
it was tempting.

We rejected it because **an eve connection authenticates with a Bearer token it
resolves itself.** Adopting it moves OAuth token storage and refresh into this
repo and out of Composio, and it removes the seam where the policy snapshot is
checked. It also does not help Linear (GraphQL, no OpenAPI document) or Gmail
(Google's spec is notoriously awkward to map to useful operations). We would
have had two architectures for seven services.

The MCP gateway costs one route and one transport interface, and gives all seven
services one shape.

---

## 3. How the agent authenticates to the gateway

The app already mints a short-lived signed token to prove "this caller owns this
workspace" — `src/domains/agents/bridge-token.ts`. It lasts **60 seconds** and
carries `userId`, `workspaceId`, and `role`.

A 60-second token cannot be pasted into a connection at startup, so the
connection mints a fresh one per tool call:

```ts
// eve/alfred/agent/connections/polymath.ts
export default defineMcpClientConnection({
  url: `${appOrigin()}/api/mcp`,
  description: "Polymath's own tools: tasks, documents, and connected services.",
  auth: (ctx) => ({
    getToken: () => signBridgeToken(
      { userId: ctx.session.auth.current!.principalId,
        workspaceId: ctx.session.auth.current!.attributes.workspaceId,
        role: ctx.session.auth.current!.attributes.role },
      { secret: bridgeSecret()! },
    ),
  }),
  headers: (ctx) => ({ "x-polymath-session": ctx.session.id }),
});
```

eve already holds `EVE_BRIDGE_SECRET` — it verifies inbound tokens with it
today — and tools already import app modules by relative path, so this needs no
new secret.

`x-polymath-session` is how the gateway finds the run that owns the caller. It
is **not** a secret; the token is. The gateway only accepts it if it resolves to
a run in the token's workspace.

### What the gateway does with each call

| Step | Check | Failure |
|---|---|---|
| 1 | Verify bearer signature and expiry | 401 |
| 2 | Resolve the run from `x-polymath-session` + token workspace | 404 |
| 3 | Run must be `running` | 409, "this run has ended" |
| 4 | Capability must be in the run's frozen policy snapshot | 403, names the capability |
| 5 | Look up the capability's risk class | 403, "no risk class" — fails closed |
| 6 | `read` / `prepare` → execute through transport | provider error, surfaced |
| 7 | `external_write` / `sensitive_write` → create proposal | returns `awaiting_review` |
| 8 | `prohibited` → refuse | 403 |
| 9 | Record the decision in `agent_authorization_decisions` | best-effort |

A write **never reaches the provider from inside a turn.** That is the existing
rule in `agents/coding.md` ("external writes become action proposals"), now
enforced where no tool author can forget it.

---

## 4. Tool discovery — keeping the prompt small

`docs/context-optimization.md` measured 521 KB of tool schemas per turn when the
tool list got large: 71% of it was MCP tools nobody had called. Twenty provider
tools advertised on every step would repeat that mistake.

eve supports `deferred: true`, which keeps a tool **out of the model's list**
and publishes it as a catalog entry the model finds with `eve__search` and calls
with `eve__tool`. Connections already work this way — every operation of an MCP
connection is discoverable, not preloaded.

So:

- **Always materialised:** `tasks_read`, `documents_search`. These are called in
  most conversations and are two small schemas.
- **Deferred:** every provider tool. The model searches for "linear issues" and
  finds `polymath__linear_read_issues`.

The practical effect: adding Vercel tools costs almost nothing until a
conversation needs them, and the eval suite proves the model still finds the
right tool.

---

## 5. The provider catalog

One table, one vocabulary. Today capability names exist in three places with
three spellings (`risk_by_capability` in the database catalog uses
`read_messages` / `send_mail`; the eval fixture uses `gmail.read` / `gmail.send`;
`authorization.ts` maps tools to `action.execute`). The gateway needs exactly one.

**Authority:** a single TypeScript module, `src/domains/integrations/capabilities.ts`.
The database's `risk_by_capability` column becomes display metadata for the
connectors screen; it no longer gates anything.

| Provider | Read tools | Write tools (proposal only) | Risk of the write |
|---|---|---|---|
| **Gmail** | `gmail_search`, `gmail_read_thread` | `gmail_send` | `external_write` |
| **Calendar** | `calendar_list_events` | `calendar_propose` (exists) | `external_write` |
| **Linear** | `linear_read_issues`, `linear_read_cycle` | `linear_create_issue` | `external_write` |
| **GitHub** | `github_read_pulls`, `github_read_checks`, `github_read_repo` | `github_draft_review` | `external_write` |
| **Vercel** | `vercel_list_deployments`, `vercel_read_logs` | `vercel_deploy`, `vercel_rollback` | `sensitive_write` |
| **Notion** | `notion_search`, `notion_read_page` | — | deferred this pass |
| **Canva** | — | — | deferred this pass |

**Why Vercel deploys are `sensitive_write` and Gmail is `external_write`:**
sending an email reaches one person and is reversible in the social sense; a
deploy reaches every user of the product and can take it down. The existing
`CAPABILITY_RISK` fixture already classed `vercel.deploy` as `sensitive_write`,
so this keeps that judgment.

**Canva is deferred** because its API surface is narrow (list designs, export
assets) and nothing in the current product asks for it. **Notion is deferred**
because an importer already exists; agent access would be a second path to the
same content, and it should be designed alongside a decision about which one
wins.

---

## 6. User stories — what each provider is actually for

These are the stories the evals are written against. Each one names the tool the
agent should reach for, and what a correct answer looks like.

### Gmail

**Read.** *"What did Priya say about the contract?"*

The agent searches the connected inbox, finds the thread, and answers citing
**subject, sender, and date**, not just the gist. If no thread matches, it says
so. It never summarises an email it did not read.

**Write.** *"Reply to Priya and confirm Thursday."*

The agent drafts a reply as a **proposal**: recipient, subject, body, and the
message it replies to. The owner sees a review card with the exact text. Nothing
sends until approved, and approval binds to that exact text — editing it
invalidates the approval.

*Today:* the proposal is created correctly and then dies. `crm/send-executor.ts`
has a `MailSender` port whose default implementation throws
`SenderNotConfiguredError`. **This slice closes that loop** by wiring a real
Gmail sender through the transport.

### Linear

**Read.** *"What's blocking the release?"*

Finds issues in the in-progress state for the relevant team and cycles, and
answers with **issue identifiers** (AXI-12, AXI-19) so the owner can go look.
Blocks are named as blocks, not inferred from title similarity.

**Write.** *"File a bug for the login timeout."*

Creates a proposal with a title, description, team, and priority. Priority is a
separate, explicit field — the agent must not smuggle urgency into the title.

### GitHub

**Read.** *"Why is the CI red on my branch?"*

Lists pull requests, then checks for the failing one, and reports **which job
failed and the first error line**. It distinguishes "no checks configured" from
"checks failed" — a distinction agents typically blur.

**Write.** *"Draft a review comment on the migration PR."*

Produces a proposal addressed to a specific pull request and file, with the
comment body. Reviewing is a write; approving it posts one comment.

### Vercel

**Read.** *"Is the deploy for branch x healthy?"*

Lists deployments for the project, then reads logs for the current one. Reports
**build state and the first error**, not "looks fine".

**Write.** *"Roll back the last deploy."*

A `sensitive_write` proposal naming the deployment being rolled back **and** the
one it replaces. This is the first genuinely dangerous capability in the system,
and the review card must make the blast radius obvious.

---

## 7. Testing — three layers, no overlap

The most important design decision after the gateway itself: **each layer tests
one thing, and none of them need a network.**

### Layer 1 — unit tests (Vitest, no database, no network)

Each typed provider module gets one test against the fixture transport:

- correct endpoint and method for a given input
- correct parsing of the fixture's shape
- the refusal path: a write on a read tool, or a malformed fixture

These run in `pnpm test` and are fast enough to run on save.

### Layer 2 — gateway integration tests (Vitest + real Postgres)

Per `agents/coding.md`, invariants run against real Postgres. The gateway has
four that a mock cannot prove:

| Invariant | The check |
|---|---|
| A capability absent from the snapshot is refused | 403, nothing written |
| A write creates a proposal and never calls the transport | transport spy sees zero calls |
| A stale/expired bridge token is refused | 401 |
| A session from another workspace cannot reach the run | 404 |

### Layer 3 — agent evals (eve, live model, stubbed tools)

These test **the agent's judgment**, not the plumbing. eve's eval stubs match
tools **by name**, so `polymath__linear_read_issues` is stubbed directly — the
gateway is never involved.

```ts
t.session({ stubs: [
  { id: "linear", tool: "polymath__linear_read_issues",
    outcome: { response: { ok: true, issues: [/* fixture */] } } },
  …one stub for every tool the agent could choose…
]})
```

That "every tool" clause is load-bearing. An earlier version stubbed only
`documents_search`, and a run that also reached for `connected_read` read the
owner's actual inbox. **An eval that can touch production data is not a test.**

What each eval asserts:

| Assertion | Why it matters |
|---|---|
| `calledTool("polymath__linear_read_issues")` | the agent looked before answering |
| input shape (`state: "started"`) | it asked the right question, not just any question |
| response cites `AXI-12` | it used what came back |
| no-match case says so | it does not invent |
| write case produces a proposal, not a claim of having acted | **the most important one** |

That last assertion is the behavioural core of the whole product: a model that
says "I've sent the email" when it filed a proposal is the failure mode
`agents/product.md` calls out first.

---

## 8. Local development

Everything runs locally with no provider accounts and no API keys:

```
pnpm dev                                        # Next app + gateway
FIXTURE_TRANSPORT=1 pnpm dev                    # gateway reads fixtures/
eve dev (in eve/alfred)                         # agent, connects to localhost
```

`FIXTURE_TRANSPORT=1` swaps `composioHttp` for `fixtureTransport`. The agent
then reads a fake Linear, a fake inbox, and a fake GitHub — and the fixtures are
the same files the evals use, so a fixture that is wrong fails both layers.

**The local/prod difference is one environment variable.** In production the
transport is Composio; nothing else changes. That is deliberate: the failure
mode we most want to avoid is "works locally, silently does nothing in prod."

---

## 9. Production topology

Both run locally and on Vercel, and the app already knows which:

```
Vercel          app + /api/mcp + eve agent, same origin
                gateway reaches the run row in Neon
                transport is composioHttp (token stays in Composio)

local           next dev on :3000 provides /api/mcp
                eve dev on its own port, or same-origin `next start`
                transport is fixtureTransport
```

`eve-driver.ts` already resolves this: `EVE_BASE_URL` → standalone; `VERCEL_URL`
→ same origin; dev-server state file → the local eve port. The connection uses
the same resolution order, so there is one answer to "where is everything".

---

## 10. Models and cost

The product's free-first rule (`src/integrations/providers/registry.ts`) says a
route never falls back to paid usage because a free allowance ran out. This
design keeps it:

- **Production:** Gemini free tier, as today (`gemini-3.5-flash-lite`).
- **Evals in CI:** a separate free-tier key so a full suite run cannot exhaust
  the production quota. The suite already runs serially
  (`maxConcurrency: 1`) because parallel cases burst the per-minute window.
- **Model comparison:** running the same eval suite against a second model is a
  supported use of the harness — swap the model resolver, not the tests. This is
  how we compare rather than guess.

Provider API calls (Gmail, Linear, GitHub, Vercel) are not model spend and are
not gated by the quota ledger. They are gated by the policy snapshot and the
proposal flow, which is the right control.

---

## 11. What this changes in the docs

| Document | Change |
|---|---|
| `agents/product.md` | "MCP server" moves from roadmap to v1 — it is internal (eve→app), not the public one |
| `agents/coding.md` | no change; this design follows its proposal rule |
| `agents/architecture.md` | add the gateway to the system map |
| `agent_authorization_decisions` | gains rows for gateway calls |

---

## 12. Deliberately out of scope

- **External MCP clients** (Claude Code, ChatGPT). The gateway authenticates
  eve only. The surface is designed so this is additive — a second auth path and
  a token table — but it is roadmap, and treating it as v1 would double the
  threat model for no user.
- **Notion and Canva provider tools** — see §5.
- **Typed tools for Calendar.** It already works end to end; rewriting it to fit
  the new shape is churn. It moves when something else forces it.
- **Model routing by task difficulty.** `evals/axiom-policy.ts` has a
  `MODEL_ROUTING_OPTIONS` table that nothing routes through. That is a separate
  design.

---

## 13. Open questions

1. **Does `linear_read_cycle` earn its place?** It is in the catalog because
   "what's in this cycle" is a common question, but the same answer usually
   comes from issues filtered by cycle. Cut it if the first slice does not need
   it.
2. **Where does the approval UI live for Vercel deploys?** The reviews queue
   exists; a deploy needs a stronger presentation than a generic proposal card.
   Design it when the slice is built, not now.
3. **What is the audit story for a read?** Reads are recorded in
   `agent_authorization_decisions`, but nobody reads those. If a promise like
   "here is everything the agent looked at" is ever made, this needs a view.
