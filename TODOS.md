# TODOS

Deferred work recorded by /ship on 2026-10-18, from the ASH-120 tranche-1 branch
(`ashwinr/ash-120-workspace-access`). Organized by component; priorities P0–P4.

## Test environment

**Priority:** P2

- **RLS evaluation suite needs a true superuser scratch DB.** rls-evaluation.test.ts
  (ASH-121 AC05) SET ROLEs a probe role; the local Supabase scratch database's
  postgres role is not rolsuper, so 2 of 825 integration tests fail locally
  with "permission denied to set role". CI's own postgres container passes
  them. Document a non-Supabase TEST_DATABASE_URL for local integration runs.
  Noticed by /ship on 2026-10-24; not caused by this branch.

## Provider/search follow-ups (2026-10-24, /ship adversarial review)

**Priority:** P2

- **Tool-support provenance for listing-only catalog entries.** ~15 models
  entered the catalog from a third-party listing without a live probe, and the
  `tools` field removal left nowhere to record that tool calling is unverified
  for them. Record tool support per entry (note or probe) before those models
  run with authored tools. Deferred from: adversarial review finding 5.
- **Gateway search is an LLM-in-the-loop route.** Each call wraps a chat
  completion around the query (tokens + per-request billing on both sides).
  The opt-in point should say so before anyone enables the entry.
  Deferred from: adversarial review finding 7.
- **searchCostEstimate settles at the estimate.** withQuota's default books
  the estimated units even when the response is smaller. Harmless for
  request-metered units; revisit if a costlier unit type lands.
  Deferred from: adversarial review finding 8.
- **Env-var reference rows for the new provider keys.** COHERE/MISTRAL/
  NVIDIA/OVH/ZAI/AI_GATEWAY keys are documented in .env.example and code but
  not in agents/reference.md's curated table. Deferred from: docs audit debt.

## QA deferred findings (2026-10-24, /qa full-product run)

**Priority:** P2

- **Stone collection vocabulary contradicts the spec.**
  `/apps/neuralflow/rewards` shows "20 points from the ledger", "+10 pts",
  "Active days", and a "streak day" reward kind — the product spec says stones
  are never points and never a streak (agents/product.md; ASH-220 §6 has the
  owner decision pending). Fix after the owner rules on the model.
- **Connectors "Setup needed" cards expose `COMPOSIO_AUTH_CONFIG_*` env-var
  names** in an end-user surface. Move the variable into a collapsed detail or
  an owner-facing settings surface; the card should say what to do, not what
  to deploy. Full audit: `.gstack/qa-reports/run-20261024T193102Z/ui-audit.md`.

**Priority:** P3

- **Briefing "Agents overnight" renders whole prompts as titles.** One run row
  showed a full JSON-schema instruction block. displayTitle (branch
  `feat/qa-full-product-fixes`) strips the markdown, but long raw prompts
  still dominate the card; a short generated label with the full prompt behind
  run detail is the upgrade.
- **Sources chip expanded list leaves one document's passages ungrouped.**
  The collapsed chip is deduped (2026-10-24); the expanded list could group
  passages per document.
- **`/today` is a dead route** with a 404 page ("Back to the briefing"). The
  rail links to the briefing, so no user path hits it, but the route should
  redirect instead of 404-ing.

## IA simplification follow-ups (2026-10-22)

**Priority:** P1

- **Spending ledger as a Today sub-tab.** Deferred from plan:
  `docs/plans/2026-10-22-ia-simplification.md` §3d. The rail entry is gone and
  `/command-center/spending` redirects to `/command-center/briefing?tab=spending`,
  but the Briefing page does not read the tab parameter and renders no ledger;
  `spending-forms.tsx` is unreachable in the canonical app. The redirect
  destination silently drops the feature.
- **Opportunities records reachable from People/Companies.** Deferred from plan:
  `docs/plans/2026-10-22-ia-simplification.md` §3f. The rail entry is gone and the
  page redirects to People, but no pursuit or opportunity links or panels exist in
  the People or Companies pages; `src/domains/opportunities/` rows are stranded
  without a UI path.

## Frontend reliability (ASH-186)

**Priority:** P2

- **TanStack Query was scoped out.** ASH-186 §3 asks for it, but `agents/agent.md` §9
  says stop before adding a runtime dependency. Server components plus Server Actions
  already cover the canonical reads and writes; the library would buy caching and
  background revalidation on the interactive surfaces. Decide whether to adopt it
  before migrating any domain to it.
- **Client request layer and the preview store are now the two error paths.** Any new
  client island calls `requestJson` (`src/lib/client-request.ts`), never raw `fetch`;
  any new preview mutation returns `{ ok, persisted }` and never reports a refused
  write as saved. Both are documented in `agents/frontend.md`.

**Priority:** P3

- **Clamped failure copy is hover-only.** `upload-dropzone.tsx` clamps a long failure
  cause to two lines with the full sentence in `title`, which a keyboard or touch user
  cannot reach. An `aria-describedby` reveal would fix it.



## Notebooks (NotebookLM parity)

**Priority:** P2

- **Unify the two citation models.** The chat stream emits `citations` frames
  carrying full `DocumentCitation` objects as structured tool output
  (`feat/eve-agents-chat-composio`). The notebook renderer parses `[[n]]`
  markers out of the model's prose (`src/domains/knowledge/inline-citations.ts`).
  Both are correct for their seam, and forcing one through the other means
  inventing markers the model never wrote. The open decision: does the agent
  generate markers, or does the renderer number structured output? Decide that,
  then delete the losing path. Until then a saved note uses the marker form and
  a streamed answer uses the frame form, and the two do not share numbering.

**Priority:** P3

- **Learning eval for answer leakage.** `tests/unit/teaching-contract.test.ts`
  pins that a teaching card carries no `answer`, `answerIndex` or `explanation`.
  That is not the same as proving the model cannot leak what it was never shown.
  The eval needs a real turn with `learning_next` as the only tool, and belongs
  next to `chat-grounding.eval.ts`. Note: evals run serially
  (`maxConcurrency: 1`) because concurrent Gemini sessions intermittently 429.

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

## Skills (ASH-200)

**Priority:** P2

- **Skills update path is a refusal, not a diff.** Re-installing a source that
  moved to a new revision is refused ("remove it first"); there is no update
  flow that shows the revision delta and applies it atomically. The spec
  deferred update/diff; build it when the library earns its keep.
- **Local import trusts one shared root.** `SKILLS_LOCAL_ROOT` is global, not
  per-workspace, so in a self-hosted multi-tenant deployment any member can
  install from the same server folders. Inert on Vercel. Gate it behind an
  explicit flag before any multi-tenant self-host ship.
- **Error mapping keys on English message prefixes.** `runs/route.ts` and the
  retry route match `cause.message.startsWith("That skill is not available")`
  to return 404; rewording the engine's message silently degrades to 502.
  Introduce a typed error class at the throw site.
- **`listRunsForSkill` filters on an unindexed jsonb expression.** Fine at v1
  scale; add an expression index on `policy_snapshot->'skill'->>'id'` when
  per-skill history becomes a hot path.
- **Residual specialist API surface.** `POST /api/v1/runs` still accepts legacy
  `specialist:*` profile names (hidden data, unreachable from the UI) and
  `eveAgentForProfile` still routes to the shared specialist agent.

**Priority:** P3

- **Local walk bounds count files, not directories or depth.** A tree of many
  empty directories is fully recursed before the 200-file cap fires; a very
  deep chain can overflow the stack. Count visited directories toward the cap
  and add a depth limit.
- **Readiness union ships two members that cannot occur yet** (Needs account
  selection, Restart required) — documented, speculative surface; produce them
  or trim when the capability-mapping slice lands.

## E2E

**Priority:** P3

- Playwright coverage of the legacy `/apps/**` preview screens still assumes
  the pre-split IA in places (switch-product journeys); reconcile with the
  launcher now that canonical chrome is single-sourced.

## Completed

- File intake sniff-mismatch contract (P0, 201-vs-200): **resolved**
  (2026-10-25). The route and test now agree on 200; the `check` job runs
  the integration suite against a real Postgres service and is green on
  main, so the red-suite concern in the entry no longer holds. Removed the
  stale entry rather than leaving a landed fix listed as open P0 work.

- ASH-120 F01–F03 (scope ADR, glossary, canonical identity schema, auth
  spine): **v-unversioned** (2026-10-18), PR #10.

## CRM / outreach

**Priority:** P1

- ~~**Ship a `MailSender` adapter.**~~ **Shipped (2026-10-23).** The Gmail
  adapter (`src/domains/crm/mail-sender.ts`) wires the existing
  `sendApprovedCorrespondence` path to Composio Gmail with the attempt id as
  the message marker; the contact page now offers "Send now" once Reviews has
  approved the exact draft (recipient address, account, subject and body all
  pinned at approval time), and the capability panel mirrors the adapter's
  `COMPOSIO_API_KEY` check. **Still gated:** a real send needs a connected
  Gmail account and an explicit approval per message; the live journey
  (approve in Reviews → Send now → mail lands) has not been exercised against
  a real provider.

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

## In-product waitlist funnel (deferred from GTM CEO review, 2026-10-24)

**Priority:** P3
**What:** Replace the hosted-form (Tally) waitlist capture with an in-product funnel:
public `waitlist` table (unique email, contextual ask, confirmed state — declared
13th-table tenancy exception outside the workspace_id spine), 5/hr/IP rate limiter
(Postgres counter; note VPN/NAT false-positives), honeypot, double opt-in via Resend,
owner-only `/admin/waitlist` surface with bot-filtered view counters.
**Why:** Keeps signup data in the product being pitched and removes the third-party
dependency — but only worth it once the funnel has real traffic.
**Pros:** Data ownership; admin + metrics native; no per-response cost.
**Cons:** New email integration from zero (no adapter exists —
`src/domains/crm/send-executor.ts` is the port pattern; needs DNS SPF/DKIM + secret),
cron wiring for the 30-day purge and 7-day token expiry
(`src/app/api/internal/cron/route.ts`), view counting conflicts with cacheComponents
prerendering (beacon route needed), invite SLA unspecified, confirmed-address
re-submission must never re-send (enumeration vector), drizzle-kit only globs
`src/domains/*/schema.ts` so the schema file must live in a domain folder.
**Context:** Deferred by /plan-ceo-review outside voice (Codex quota exhausted; native
fallback found 9 findings) and owner decision 2026-10-24: six scope items to collect
emails for a page with zero visitors was premature infrastructure. Upgrade trigger:
~50 confirmed signups via the hosted form, or when the landing page moves to in-product
capture for launch. Landing route itself IS in scope now (proposal-hero, static,
mobile-width) — only the capture backend is deferred.
**Effort:** human M (2-3 days) / CC ~1-2 hours.
**Depends on:** hosted-form funnel producing real traffic first.
