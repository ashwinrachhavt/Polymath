# Connector permissions and shell — implementation plan

**Spec:** the owner's requests of 2026-10-21: per-connector read/write toggles where write
means "may file a proposal"; a Linear-style grouped history dropdown on the Assistant; and a
collapsible rail with the vertical space reclaimed.

**Decisions already made** (owner, this session):
- Read and write are separate per-connector switches. Write is off by default.
- Enabling write grants the capability that lets an agent *propose*, never one that sends.
- Providers are Composio-managed only; Vercel stays absent because it cannot mint a link.

---

## Global constraints

- **Write never means "send".** A toggle may add a `*.write` capability to the profile's
  snapshot; the gateway still turns every write into an `action_proposals` row. Any change
  that lets a toggle cause a provider call is wrong and must be reverted.
- **`agents/coding.md`**: db constraints for invariants, server components for reads, server
  actions for mutations, no new dependencies, terse WHY-only comments.
- **The capability vocabulary is `src/domains/integrations/capabilities.ts`.** Do not invent
  a second naming scheme; the DB catalog column is display metadata only.
- **`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`** must all pass before any task
  is complete. `pnpm build` specifically, because unit tests missed a build break earlier.
- Comments explain WHY. No `TODO` without an owner.

---

## Task 1 — Store the per-connector permission

**Files:** `src/db/migrations/0224_connector_permissions.sql` (new),
`src/db/migrations/meta/_journal.json`, `src/domains/integrations/schema.ts`,
`tests/integration/connector-permissions.test.ts` (new).

### What changes

`external_accounts` gains two booleans, defaulting to read-on/write-off:

```sql
ALTER TABLE "external_accounts"
  ADD COLUMN IF NOT EXISTS "allow_read" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "allow_write" boolean NOT NULL DEFAULT false;
```

Read defaults true because an account the owner connected is one they expect the agent to
read; write defaults false because a granted write is a decision, not a default.

Add `allowRead` and `allowWrite` to the drizzle table with `.notNull().default(...)` matching.
Journal entry `0224_connector_permissions` at idx 224 (main tops out at 0223 after this
branch's connector expansion).

Test (real Postgres): a fresh account row has read true and write false; a row can be flipped;
the defaults survive an insert that names neither column.

### Acceptance

```sh
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/connector-permissions.test.ts
pnpm check:migrations origin/main
pnpm typecheck
```

### Do not

- Add a third permission. Read and write are the whole model.
- Enforce the permissions here; Task 2 reads them.

---

## Task 2 — Enforce the permission at the two places that act

**Files:** `src/domains/integrations/queries.ts`,
`src/domains/agents/gateway.ts`, `tests/integration/mcp-gateway.test.ts`.

### What changes

`resolveConnectedAccount` currently returns any `active` account. It must also refuse an
account whose permission does not cover the capability's kind:

- a `read` capability needs `allowRead`
- a `proposal` capability needs `allowWrite`

Add `kind: "read" | "proposal"` to its input (the caller knows it from `CAPABILITIES`), and
return `{ ok: false, code: "permission_denied", message }` with a message that names the
switch the owner would flip ("Reading Gmail is off for \"work-gmail\". Turn it on in
Connectors."). The gateway already maps a failed account resolution to 403; verify it keeps
doing that and that the message reaches the model.

Two places call it: the gateway's read path and the gateway's proposal path. Both must pass
the kind. `connected_read` is gone, so there is no third caller.

Test (real Postgres, fixture transport): with write off, `gmail_send` returns 403 and the
transport spy sees zero calls; with write on, the same call returns `awaiting_review`; with
read off, `gmail_search` returns 403.

### Acceptance

```sh
TEST_DATABASE_URL=postgresql://axiom:axiom@localhost:5432/axiom_test \
  pnpm exec vitest run --project db tests/integration/mcp-gateway.test.ts
pnpm typecheck
```

### Do not

- Let a permission replace the policy snapshot. Both must pass; the permission narrows.
- Call a provider to test a permission.

---

## Task 3 — The toggles in the connector card

**Files:** `src/app/(workspace)/command-center/integrations/connector-controls.tsx`,
`connector-catalog.tsx`, `actions.ts`, `page.tsx`.

### What changes

Each account row gains two switches, `Read` and `Write`, in the card's existing row rhythm
(no new component library, no icons-in-circles). Copy states what each grants:

- Read — "Search and read. Executes immediately."
- Write — "Propose changes for your approval. Nothing is sent directly."

`Write` is disabled with a reason when the provider has no write capability in the catalog
(e.g. a read-only provider), rather than showing a switch that does nothing.

A server action `setAccountPermissionAction({ accountId, expectedVersion, allowRead,
allowWrite })` writes both flags with the version check the other account actions use, then
revalidates. Reuse the existing `Result` shape.

Layout per the app-screen house rules: label 12–14px sentence case, control on the right,
14px description beneath, no tinted tiles, no gradients, one accent.

### Acceptance

```sh
pnpm typecheck && pnpm lint && pnpm build
```

Manual in the browser at 1440 and 390: flipping Read off and reloading shows it persisted;
Write is absent/disabled for a provider without a write capability; the account row does not
change height when the switches appear.

### Do not

- Add a "save" button. Each switch saves itself (one save model per view).
- Colour the switches with the product accent; the app-screen rules put colour on data only.

---

## Task 4 — The grouped history dropdown

**Files:** `src/app/(workspace)/alfred/history-menu.tsx` (new),
`src/app/(workspace)/alfred/page.tsx`, `src/lib/time.ts` (add a group helper only if absent).

### What changes

A disclosure button labelled `New chat` at the top-left of the Assistant, opening a panel
that groups the workspace's recent conversations by recency — **Today**, **This week**,
**Older** — each row showing the objective truncated to one line and a relative time on the
right. Clicking a row goes to `/alfred/<id>`.

Rules that come from the reference and from the house rules:

- Groups render only when they have rows. No empty "Older".
- Rows are 32px on a 34px pitch, 13px label, 12px grey time, truncated with an ellipsis.
- The panel is the only floating surface on the page, so it may carry a shadow.
- It closes on Escape, on an outside click, and on navigation.
- The same list already renders under the composer as "Recent"; keep that, but cap it at
  five and let the dropdown be the complete history. Two views of one array, not two queries.

Grouping is date math, so it goes in a pure function with tests, not in the component.

### Acceptance

```sh
pnpm exec vitest run --project unit tests/unit/history-groups.test.ts
pnpm typecheck && pnpm build
```

Manual: a run from today lands under Today, a run 3 days old under This week, a run 30 days
old under Older; the menu closes on Escape.

### Do not

- Add a search field inside the menu yet.
- Change what `/alfred/<id>` renders.

---

## Task 5 — Collapse the rail with an arrow, and reclaim the height

**Files:** `src/components/shell/side-nav.tsx`, `src/components/shell/app-shell.tsx`,
`src/app/(workspace)/alfred/page.tsx`, `src/app/(workspace)/alfred/[runId]/page.tsx`.

### What changes

**The rail.** Replace the current collapse affordance with a chevron button at the rail's
top-right that flips left/right, `aria-expanded` and an `aria-label` that says which way it
will go ("Collapse navigation" / "Expand navigation"). The collapsed width stays 52px; the
icon-only state keeps a tooltip and an accessible name per item (house rule: an icon rail
always carries the product mark, a tooltip and a name). Persist the choice as it does today.

**The height.** The conversation page currently stacks a sticky header (`page-header`, sticky
top-12) plus a second "Conversation" header inside `ChatSurface`, so two headers burn about
150px before a single message. Fix by: the run page renders its own compact header (back
link, objective, status) and passes no title to `ChatSurface` when the page already names the
conversation; `ChatSurface` then drops its header row entirely and starts at the transcript.
The composer stays pinned to the bottom.

Do not remove the run header: the objective is what the page is about, and the app-screen
rules require a title on every screen.

### Acceptance

```sh
pnpm typecheck && pnpm lint && pnpm build
```

Manual at 1440x900: collapsing the rail leaves every icon reachable and labelled; the
conversation page shows its first message without scrolling; the composer is visible without
scrolling; nothing overlaps at 390px.

### Do not

- Delete the container-toggle-indicator form the side nav currently has; `app-shell.tsx`
  matches on it to lay out the terminal dock.
- Change any destination.

---

## Out of scope

- Tool call / thinking persistence (its own plan).
- Loop detection and summarisation middleware.
- Provider tools for the 20 new connectors: the catalog and permissions land first, the
  gateway tools follow per provider.
