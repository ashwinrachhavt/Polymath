# Polymath Consolidation Design

**Date:** 2026-10-10
**Ticket:** ASH-101 (Linear, ashwinr workspace)
**Repo:** `~/projects/axiom` (new, not yet a git repo)

## 1. Purpose and Constraints

Unify three existing personal apps into one GSuite-like Personal OS experience:

| App | Location | Stack | Web | API | DB |
|---|---|---|---|---|---|
| command-center | `~/Projects/command-center` | FastAPI + Next.js 14/15 + Celery/Redis + Clerk | :3001 | :8000 | PG17 :55432 |
| alfred | `~/Projects/alfred` | FastAPI + Next.js 16 + Qdrant + Clerk | :3010 | :8000 | PG :5432 + Qdrant :6333 |
| neuralflow | `~/Projects/neuralflow` | Next.js 16 + Prisma + Clerk | :3000 | (Next API routes) | pgvector :5432 |

**Hard constraints (user-stated):**
- No code changes to the three donor apps, ever.
- Reuse code as much as possible; consolidation is in UX and branding feel.
- Polymath frontend is Next.js 16.
- Auth: shared Clerk.

## 2. Approach (decided)

**Approach B — unified screens with reuse-first adaptation.** Polymath has its own
screens for the core loop, each adapted from a donor frontend's page component
(copied into Polymath, restyled to the Polymath theme, backend client swapped). Long-tail
deep screens are iframed from the running donor apps. One shell, one brand, one nav.

Not chosen:
- **A (shell + iframe only):** cheapest, but the screens stay visually three apps; fails "consolidated UX/branding."
- **C (full rebuild of every screen):** three API surfaces maintained forever, weeks of work for marginal gain.

## 3. Architecture

```
Browser ──> Polymath (Next.js 16, :3000)
              ├── src/lib/backend/{cc,alfred,neuralflow}.ts   (typed fetch clients)
              ├── /api/* routes        (Chat-forward proxy where needed)
              └── deep screens ── iframe ──> donor app web (:3001/:3010)
                              │
                              ▼
        command-center FastAPI (:8001)   alfred FastAPI (:8000)   neuralflow Next API
        (untouched)                      (untouched)              (untouched)
```

- Browser talks only to Polymath. Axiov calls backends server-side (Next API routes)
  or client-side with the Clerk Bearer token forwarded.
- command-center already generates its frontend types from its OpenAPI spec; Polymath
  does the same (`make contracts` pattern against CC's :8001 spec).
- Alfred API consumed as-is. Neuralflow's Next API routes called with the
  incoming request's Clerk cookies forwarded by Polymath's proxy (verified:
  `neuralflow/src/middleware.ts` runs `clerkMiddleware` on `/api|trpc` and 401s
  without a session — the earlier "token-optional" claim was wrong; D4 review
  decision). Clerk session cookies are host-scoped, so localhost:3000 and
  localhost:3010 share `__session`.
- Shared Clerk assumption: all three donors must point at the **same Clerk
  instance** (same publishable key's frontend API) for Polymath's single sign-in
  to work across the stack. Verified at build start — if donors were
  provisioned from different Clerk projects, the `__session` cookie would
  authenticate only one of them and Polymath's auth story splits.

### Screen map (v1)

| Polymath screen | Adapted from | Backend |
|---|---|---|
| Today plane + Briefing | CC Briefing (composition: neuralflow scheduler queried by the same Polymath screen) | CC `tasks`, neuralflow `scheduler` |
| Inbox (captures/proposals) | Alfred inbox | alfred API |
| Focus sessions | Neuralflow pomodoro / alfred focus | neuralflow API |
| Boards & tasks | Neuralflow boards / CC tasks | CC + neuralflow |
| Knowledge (zettels, notes) | Alfred knowledge/notes | alfred API |
| Jobs/Opportunities | CC jobs | CC API |
| Canvas, reports, autofill, admin, dossiers, research | **iframed** from donor web | — |

## 4. Deployment (Polymath owns it)

Polymath ships a `Makefile` and `.env.axiom` that orchestrate all four apps
**without editing donor repos** (D5 review decision: env-file only, no override
YAML — every donor port is already env-parameterized, verified at
`alfred/docker-compose.yml:79/:293/:366` and `command-center/compose.yaml:156/:177/:207`):

- **Alfred Postgres moved to :5433** — `ALFRED_POSTGRES_PORT=5433` in
  `.env.axiom`, passed via
  `docker compose --env-file .env.axiom -f ~/Projects/alfred/docker-compose.yml up`.
  Neuralflow keeps :5432 (its compose hardcodes 5432, which is fine once alfred
  moves off it).
- **CC API on :8001** — `API_PORT=8001` in `.env.axiom` (alfred keeps
  `ALFRED_API_PORT=8000`).
- **CC Clerk authorized parties** — CC's FastAPI verifies Clerk session JWTs
  against `CC_CLERK_AUTHORIZED_PARTIES` (azp claim, per Clerk's manual-JWT
  verification guide), which defaults to `["http://localhost:3001"]`. Sessions
  minted on Polymath at :3000 carry azp `http://localhost:3000` and would be
  rejected. `.env.axiom` sets
  `CC_CLERK_AUTHORIZED_PARTIES=["http://localhost:3001","http://localhost:3000"]`
  (env-parameterized at `compose.yaml:17`; donor repo untouched). The var is
  empty in CC's committed `.env`, so `.env.axiom` is the canonical source.
- Final port map: Polymath :3000, neuralflow web :3010, CC web :3001, alfred web :3020,
  alfred API :8000, CC API :8001, alfred PG :5433.
- `make up` / `make up-alfred` / `make up-cc` / `make up-neuralflow` targets +
  one `make status` that pings all four health endpoints.
- Bare `npm run dev` per-app fallback documented in Polymath README.

## 5. Branding/UX Consolidation

- One `axiom` design token set in a single `:root` block (colors, type scale,
  spacing), dark-mode variant via `@media (prefers-color-scheme: dark)`.
- One shadcn theme shared across all adapted screens. All three donor frontends
  already use shadcn/Tailwind, so component vocabulary transfers directly.
- Sidebar with app sections (Today, Inbox, Focus, Boards, Knowledge, Briefing,
  Jobs, Settings) — GSuite pattern: one chrome, multiple "apps" in the nav.
- Deep iframed screens keep donor look in v1 (accepted gap).

## 6. Error Handling

- Backend down → screen renders a labeled card ("Alfred isn't running — run
  `make up-alfred`"), not a crash. All three backend clients share one
  `fetchWithStatus()` helper in `src/lib/backend/client.ts` (try/catch → status
  shape); per-app wrappers stay thin.
- Iframe note (D2, review decision): iframed donor screens may hit Chrome
  third-party cookie partitioning (blank/logged-out frame). Accepted v1 risk for
  local solo dev; fallback documented in Polymath README — open the donor origin
  directly (first-party) once, then the iframe inherits a valid partitioned
  session; otherwise run `make up-<donor>` and open the screen at the donor origin.

## 7. Testing

- One integration smoke test: health of all three backends + exercise Today,
  Inbox, Focus read paths against running donors (incl. cookie-forward to
  neuralflow, per R3) + backend-down → status-card path via fetchWithStatus().
- The smoke test is **manual-only** for v1: it requires live donor containers
  and a live Clerk session, so it is unrunnable in CI even once git exists.
  Run it via
  `smoke/README` after `make up`.
- Donor repos keep their own suites; Polymath adds only its own lint/typecheck.

## 8. Explicitly Skipped (YAGNI, v2 candidates)

- No shared database or cross-app queries.
- No `action_events` bounded-approval ledger (CLAUDE-side gate loop) — v2 once
  the shell exists.
- No monorepo merge of donor repos.
- No donor-repo edits, ever.

---

## Decision ledger

### R1: File/directory arrangement of Polymath scope
Finding: complexity gate, 8+ proposed files (plan-eng-review Scope Challenge B)
Plan baseline: §3–§7 as originally proposed (~18 files, single Next.js app)
Runtime evidence: n/a (new project, no existing code)
Comparison grid: A) original single-app arrangement ~18 files / B) smaller split (workspace route-group + per-domain clients) ~24 files; same feature set both
Question D1: Polymath scope structure: original single-app arrangement or a smaller split?
Header: Structure
Options:
A) Original arrangement (recommended)
Keep the single Next.js app: ~18 files (7 screens, 3 backend clients, shell, theme, compose, Makefile, health, smoke test). All donor repos untouched; everything in Polymath.
B) Smaller arrangement
Same feature set, but reorganize: split screens into a workspace/ dir separate from embed host and api proxy, and split backend clients per-domain. More files, marginal organization gain.

State: approved
Actual answer: A — "Original arrangement (recommended)" (AskUserQuestion D1)
Accepted scope: original single-app arrangement, full v1 feature list, zero donor edits.
History: proposed as complexity-gate question; no cuts proposed, feature list kept.

### R2: Iframing Clerk-authenticated donor apps
Finding: P1, confidence 9/10 — iframed donor screens can hit Chrome third-party
cookie partitioning (silent blank/logged-out frames) (plan-eng-review Scope Challenge C)
Plan baseline: §3/§6 as originally proposed — iframes as accepted look-gap, no auth-failure handling
Runtime evidence: browser-enforced behavior since 2024 (MDN, learn.microsoft.com, community reports); no in-repo code yet
Comparison grid: A) accept risk + README fallback note / B) restrict iframes to cookie-optional screens, tab-out for auth screens / C) no iframes in v1
Question D2: iframing Clerk-authenticated donor apps: accept the third-party-cookie risk, restrict iframes, or drop them?
Header: IsoLa� inframes
Options:
A) Accept risk, document fallback (recommended)
Keep iframing all long-tail screens. Fallback: document `make up-<donor>` + open donor origin directly (first-party); accept the risk in v1 (solo local dev, same machine, low stakes).
B) Restrict iframes, tab-out for auth screens
Keep iframing only for cookie-optional/public donor screens; for Clerk-required donor screens, open in a new browser tab instead. Removes the failure mode but loses the "one chrome" feel for those screens.
C) No iframes in v1
Drop iframes from v1; only adapt-screen approach. Smallest risk but loses access to donor long-tail screens until v2.

State: approved
Actual answer: A — "Accept risk, document fallback (recommended)" (AskUserQuestion D2)
Accepted scope: iframes kept; risk documented in Polymath README (§6 iframe note added to the spec).
History: raised as P1 finding with 9/10 confidence from web research (Chrome 2024+ cookie partitioning).

### R3: Neuralflow API authentication from Polymath
Finding: P1, confidence 9/10 — spec line 52 claimed neuralflow API routes are
token-optional; actually `neuralflow/src/middleware.ts` runs clerkMiddleware on
`/(api|trpc)(.*)` and returns 401 JSON without a session (plan-eng-review Architecture)
Plan baseline: spec's original "called directly, token-optional" claim
Runtime evidence: read `neuralflow/src/middleware.ts` (clerkMiddleware, matcher `/(api|trpc)(.*)`, `NextResponse.json({message:"Unauthorized"},{status:401})` when `!userId`)
Comparison grid: A) forward incoming request cookies in proxy / B) DEV_AUTH_BYPASS=1 env only (donor-defined dev loophole) / C) both
Question D4: Neuralflow API 401s: how does Polymath authenticate to neuralflow?
Header: NF auth forward
Options:
A) Forward cookies in proxy (recommended)
Polymath's /api proxy reads the incoming request's cookies and forwards them to neuralflow (~2 lines). Works in dev/production parity; donor untouched; matches shared-Clerk choice.
B) DEV_AUTH_BYPASS=1 env only
Polymath's dev env sets the donor bypass flag. Zero code but dev-only and couples Polymath to a donor flag.
C) Both, env as fallback
Cookie forwarding plus documented DEV_AUTH_BYPASS=1 fallback for when Clerk keys aren't configured.

State: approved
Actual answer: A — "Forward cookies in proxy (recommended)" (AskUserQuestion D4)
Accepted scope: spec §3 corrected — Polymath proxy forwards Clerk cookies to neuralflow; donor repos untouched.
History: spec line 52 corrected per Architecture finding.

### R4: Deployment port overrides
Finding: P2, confidence 8/10 — spec proposed Polymath-owned override YAML files;
donor compose files already parameterize every port via env vars
(alfred `ALFRED_POSTGRES_PORT`/`ALFRED_API_PORT`/`ALFRED_WEB_PORT` at
docker-compose.yml:79/:293/:366, CC `API_PORT`/`WEB_PORT` at compose.yaml:177/:207)
(plan-eng-review Architecture)
Plan baseline: §4 as originally proposed (overrides/alfred.override.yml + compose merge)
Runtime evidence: read both donor compose files; all needed ports are `${VAR:-default}` parameterized
Comparison grid: A) one Polymath .env.axiom + --env-file (zero override files) / B) keep override YAML files (same coverage, more files)
Question D5: Port overrides: env-file only, or Polymath-owned override YAML files too?
Header: Port overrides
Options:
A) One Polymath .env, no override files (recommended)
One `.env.axiom` passed via `docker compose --env-file` per donor. Every needed port is verifiably env-parameterized in donor compose files.
B) Keep override YAML files
Keep `overrides/alfred.override.yml` merged via `-f` merge. Explicit in the Polymath repo but duplicates env-parameterized values.

State: approved
Actual answer: A — "One Polymath .env, no override files (recommended)" (AskUserQuestion D5)
Accepted scope: §4 rewritten — .env.axiom + Makefile only, no override YAML, no compose.yaml in Polymath.
History: original §4 replaced per D5 answer.

### R5: Smoke test coverage expansion
Finding: P2, confidence 7/10 — Test review coverage diagram shows cookie-forward
(R3) and fetchWithStatus error paths are the two Polymath-only paths that would
silently regress; donor suites don't cover them (plan-eng-review Test review)
Plan baseline: §7 smoke test = backends' health + Today/Inbox/Focus read paths
Runtime evidence: n/a (new repo, no existing tests)
Comparison grid: expand §7 smoke test to name cookie-forward + status-card paths (recommended) / add separate unit test suite / leave §7 as-is
Question: not asked (no independently selectable outcome — the expansion is a one-line clarification of the already-approved smoke test, same behavior, same suite)
Options: n/a

State: approved (inline, no decision gate — clarification of approved behavior)
Actual answer: n/a (inline acceptance per Code Quality/Test review posture)
Accepted scope: §7 smoke test now names cookie-forward and status-card paths.
History: derived from R3/D4 and Section 2's shared-helper note.

### R6: Outside-voice findings (codex unauthenticated, in-host fallback)
Finding: codex CLI 401 (not authenticated) — in-host pass returned 5 findings
(1-P1 azp allowlist, 2-P2 bootstrap ordering, 3-P2 shared Clerk instance,
4-P3 screen-map dual-source wording, 5-P3 manual-only smoke test)
Plan baseline: §4 (no CC authorized-parties handling) / §7 (no manual-only marker)
Runtime evidence: command-center/compose.yaml:17 azp default; clerk.com
manual-JWT verification guide confirms authenticate_request() compares azp
Comparison grid: fold 1/2/3/5 inline (mechanical continuations of D5 and the
approved Shared Clerk choice) / one-line clarification for 4

State: approved (inline — continuations of approved decisions D4/D5 + Shared Clerk)
Actual answer: n/a (no independently selectable outcome; each fold-in applies an
already-approved choice to a previously unstated consequence)
Accepted scope: §4 CC_CLERK_AUTHORIZED_PARTIES bullet, §3 shared-instance
verify-at-build bullet, §7 manual-only marker, screen-map wording.
History: outside-voice pass; codex unavailable (auth), in-host fallback used.

Approval readiness: PASS — checked R1 (D1 original arrangement), R2 (D2 accept-risk
+ README fallback), R3 (D4 forward cookies), R4 (D5 env-file only), R5 (inline,
approved behavior), R6 (inline, continuations of D4/D5 + approved Shared Clerk
choice). Every accepted remedy cites its actual answer; no deferrals outstanding.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~2h / CC: ~10min)** — Scaffold Polymath shell — init Next.js 16 app in `~/projects/axiom`, git-init, Polymath design tokens + sidebar shell with nav sections (Today, Inbox, Focus, Boards, Knowledge, Briefing, Jobs, Settings)
  - Surfaced by: Architecture review / Scope Challenge B — original single-app arrangement approved (R1)
  - Files: `~/projects/axiom/{package.json,src/app/layout.tsx,src/app/globals.css,src/components/shell/*}`
  - Verify: `npm run build` passes; sidebar renders at :3000
- [ ] **T2 (P1, human: ~4h / CC: ~30min)** — Backend clients — `src/lib/backend/client.ts` with shared `fetchWithStatus()` + thin `cc.ts`/`alfred.ts`/`neuralflow.ts` wrappers; CC types via `make contracts` against :8001
  - Surfaced by: Code quality review — one shared status-shape helper for three clients
  - Files: `src/lib/backend/{client,cc,alfred,neuralflow}.ts`, `Makefile` (contracts target)
  - Verify: typecheck passes; typecheck against generated CC types
- [ ] **T3 (P1, human: ~1h / CC: ~5min)** — `.env.axiom` + Makefile — port map per §4 including `API_PORT=8001`, `ALFRED_POSTGRES_PORT=5433`, `CC_CLERK_AUTHORIZED_PARTIES=["http://localhost:3001","http://localhost:3000"]`
  - Surfaced by: Architecture review (R4) + outside voice finding 1 — CC FastAPI azp allowlist rejects Polymath-minted sessions without the override
  - Files: `.env.axiom`, `Makefile` (up/up-*/status targets)
  - Verify: `make up` boots all four without port collisions; CC API reachable on :8001
- [ ] **T4 (P1, human: ~4h / CC: ~45min)** — Clerk wiring — Polymath `src/proxy.ts` (clerkMiddleware), shared Clerk publishable key from one instance across Polymath, and verify all three donors point at that same instance; `/api/[...proxy]` forwards incoming cookies (R3)
  - Surfaced by: Architecture review (R3/D4) + outside voice finding 3 — unverified shared-instance assumption
  - Files: `src/proxy.ts`, `src/app/api/[...proxy]/route.ts`, `.env.axiom`
  - Verify: sign in on Polymath → neuralflow API call returns 200 (not 401)
- [ ] **T5 (P2, human: ~2h / CC: ~20min)** — Adapt core screens — Today, Inbox, Focus, Boards, Knowledge, Jobs from donor page components (one donor source each per §5 screen map), swapped to Polymath backend clients
  - Surfaced by: Screen map (v1) — Approach B reuse-first adaptation
  - Files: `src/app/{today,boards,knowledge,jobs}/page.tsx` etc.
  - Verify: each screen renders real donor data through its backend client
- [ ] **T6 (P2, human: ~1h / CC: ~10min)** — `/health` page + backend-down status cards — screenshot all four apps, labeled card with `make up-<donor>` hint on failure
  - Surfaced by: §6 Error handling / Test review critical path 3
  - Files: `src/app/health/page.tsx`, status-card component
  - Verify: stop one donor → card shows, no crash; all-down → 4 cards
- [ ] **T7 (P2, human: ~1h / CC: ~15min)** — `/embed/[app]` iframe host — iframes for canvas, reports, autofill, admin, dossiers, research
  - Surfaced by: §2/§5 — long-tail screens iframed; D2 risk accepted with README fallback
  - Files: `src/app/embed/[app]/page.tsx`, README (fallback instructions)
  - Verify: donor frame renders; blank-frame fallback path documented
- [ ] **T8 (P2, human: ~2h / CC: ~30min)** — Integration smoke test — health of all three backends + Today/Inbox/Focus reads + cookie-forward to neuralflow + backend-down status card; manual-only, run after `make up` (§7)
  - Surfaced by: Test review (R5) — Polymath-only paths with no upstream coverage
  - Files: `smoke/axiom-smoke.ts`, `smoke/README`
  - Verify: `make up` then run smoke — all checks pass including the CC azp path (T3)
- [ ] **T9 (P3, follow-up TODO)** — Second donor composition for Today (neuralflow scheduler queried by the Polymath Today screen) once the CC-based path is live
  - Surfaced by: Outside voice finding 4 — one donor source per screen in v1; second source is composition
  - Files: `src/app/today/page.tsx`
  - Verify: Today renders both data sources

_No new tasks from Performance review — both P3 findings were no-action (unknown/small scale)._

## NOT in scope (v2 candidates)

- **Shared database / cross-app queries** — §8; coupling the donor schemas eliminates their independence.
- **Bounded-approval ledger (`action_events`)** — §8; the shell must exist before the gate loop has anything to gate.
- **Monorepo merge of donor repos** — §8; donor repos stay untouched per hard constraint, so the merge would fight that constraint.
- **Donor-look unification for deep iframed screens** — §5; adapting every donor screen defeats the iframe's whole cost advantage (v2 if the brand gap chafes).

## What already exists (reuse map)

- **CC frontend types pipeline** (`make contracts` → OpenAPI types) — reused as-is by Polymath (T2). Code Quality decision: shared `fetchWithStatus()` helper is new in Polymath; per-app wrappers stay thin.
- **Donor page components** — copied + restyled per screen (T5); neuralflow and alfred already share shadcn/Tailwind vocabulary, so the theme transfer is mechanical.
- **Donor compose env-parameterization** — verified at `alfred/docker-compose.yml:79/:293/:366` and `compose.yaml:156/:177/:207`; Polymath's `.env.axiom` overrides values rather than re-declaring services (R4/D5).
- **Donor suites** — kept and run at their own pace (§7); Polymath adds only lint/typecheck + its own smoke test.

## Failure modes (new paths)

- **CC API 401 via azp mismatch** (T3): CC FastAPI rejects Polymath-minted JWTs when the authorized-parties allowlist omits :3000. Covered by T3's `.env.axiom` + T8 smoke test. Users see 401 card → clear, not silent.
- **Neuralflow API 401 with cookies not forwarded** (T4/T8): proxy drops cookies. Covered by R3 design + smoke test. 401 card → clear.
- **Backend-down crash** (T6): a fetch throw escapes `fetchWithStatus()`. Covered by try/catch shape + critical path 3 test. Status card → clear.
- **Iframe blank from cookie partitioning** (T7): Chrome partitions third-party cookies, frame renders logged out. Accepted v1 risk (D2); README fallback documented. User sees blank frame — **flag: no test and no in-product error handling relies on it; silent to the app, mitigated by documentation.** Watch this in v1 dogfooding.
- **Port collision on boot** (T3): a donor compose rerun without `.env.axiom` grabs a default port. Covered by `make status` pings; user sees failed health → clear.

## Suppressed findings

- **Performance 1-P3:** extra server hop per backend call (client → Next route → backend). Unknown at local scale; no action this review.
- **Performance 2-P3 (suppressed):** iframe memory footprint with multiple deep screens mounted. Suppressed per Code Quality posture — local solo dev, not measurable now.

## Worktree parallelization strategy

Sequential implementation, no parallelization opportunity. T1 scaffolds the
single shell everything else mounts into; T2–T8 all touch `src/lib/backend/`,
`.env.axiom` or the shared proxy — every lane would collide on shared files.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Outside Review | codex (unavailable — 401 unauthenticated); in-host fallback | Independent 2nd opinion | 1 | unavailable | 5 findings (in-host), 5/5 folded inline |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 13 issues (4 arch, 2 code-quality, 6 test+1 E2E, 2 perf), 0 critical gaps; all mapped to tasks T1–T9 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**OUTSIDE COVERAGE:** codex CLI failed (401 unauthenticated on api.openai.com, websocket + HTTPS fallback, 5/5 reconnects) — in-host fallback used with the same prompt; 5 findings returned, all resolved inline (R6). No external provider completed, so outside voice is not established for this plan.
**VERDICT:** ENG ISSUES OPEN (all findings mapped to tasks T1–T9; P1s are scaffolding, not design flaws) — design review pending before implementation sign-off.

**UNRESOLVED DECISIONS:**
- Shared Clerk instance not yet verified — all three donors must resolve to the same Clerk publishable key's instance; 5-minute check at build start (T4), currently an accepted assumption only.
