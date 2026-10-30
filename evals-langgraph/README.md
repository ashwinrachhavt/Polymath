# Polymath LangGraph eval harness

This loose directory package complements eve; it does not replace it or modify application behavior. Install from the repository root with `pnpm install` (Node 24+). Dependencies resolve from the root, just like `eve/polymath`; there are no workspace-glob changes.

## Fresh-machine runbook (the whole loop)

The user-run **credentialed live verification is the promotion gate for release PR #365** — this page is the one place that describes it end to end.

1. **Prerequisites:** Node ≥ 24 (`.node-version`), pnpm 12.x (`corepack enable`), Docker.
2. **Install:** `pnpm install` from the repo root.
3. **Configure:** `cp .env.example .env`, then set `DATABASE_URL` (compose default `postgresql://axiom:axiom@127.0.0.1:5432/axiom`), `EVE_BRIDGE_SECRET` (`openssl rand -hex 32`), a separate 32+ character `EVE_GATEWAY_SECRET` in both the app and Eve environments, and `GEMINI_API_KEY`. Leave Clerk vars unset — dev-user auth needs none. No `LANGFUSE_*` yet; step 6 mints them.
4. **App stack:** `docker compose up -d` → `pnpm db:migrate` → start `eve dev` in `eve/polymath` (the agent runtime; the app discovers it via `.eve/` state files). Leave `next dev` to step 7 — the harness supervises its own copy, and a stale manual `pnpm dev` on port 3000 would satisfy readiness without its stdout being captured.
5. **Fixture check (no keys needed):** `make evals` — routing + approval-classifier run deterministically, reconciliation reports `not_applicable`, exit 0.
6. **Tracing stack:** `make langfuse-up`, then mint keys per `docs/langfuse-local.md` (sign up at `http://127.0.0.1:3100`, create project, create API keys) and export `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL=http://127.0.0.1:3100` in both shells (app/eve and harness).
7. **Live verification (promotion gate):** export the step-3 values into the harness shell first (`cd evals-langgraph && set -a && . ../.env && set +a`) — the harness reads `process.env` directly and, unlike `eve dev`/`next dev`, does not load root `.env` — then `pnpm eval --live --strict --supervise-dev` — starts and supervises its own `next dev` (dev mode is required for the auth bypass; without `--supervise-dev` nothing captures app stdout and reconciliation downgrades to pending, exit 2), drives real runs through `POST /api/v1/runs`, waits for terminal state, and runs all six reconciliation groups against real Postgres rows, Langfuse observations and the captured stdout window. Promotion requires exit 0 (or exit 2 while required credentials are missing — that blocks promotion, it does not waive the gate); keep the JSON report as evidence.
8. **A red eval vs broken reconciliation:** the graph scores first and reconciles separately — a failing eval (exit 1) and a reconciliation failure are reported independently; `--skip-reconcile` reports `skipped` and never counts as passing.

## Run deterministic cases

```sh
cd evals-langgraph
pnpm eval --strict
pnpm dev --no-browser
```

`pnpm dev` runs the local LangGraph API and prints the Studio URL. Submit `{"caseId":"routing/allowlist"}` or `{"caseId":"approval-classifier/policy"}` to the `eval-case` graph. Run configuration is a case ID, not executable matcher functions; graph state is serializable. The CLI executes cases serially (eve's quota-conscious concurrency of one).

Routing and approval use eve's real `decide` pipeline with deterministic mock deciders and import the unchanged `eve/polymath/evals/axiom-policy.ts`. They require no app server, model credentials or database. Their reconciliation is **not applicable**, never passed. They create no application run ID, records or traces.

## Live HTTP path

Start the application with `next dev` — or let the harness supervise its own copy with `--supervise-dev`, which is what the live runbook uses so stdout capture and the drive target are the same process — and eve with the same local environment. `pnpm eval --live --strict` selects the four live case definitions. It requires `GEMINI_API_KEY` and uses dev-user auth by default; `POLYMATH_COMPANION_TOKEN=axm_<keyId>.<secret>` selects companion auth. `POLYMATH_EVAL_BASE_URL` defaults to `http://127.0.0.1:3000`; only credential-free loopback HTTP(S) origins are accepted. The harness never targets a production deployment.

The credential gate is independent of eve's eval gate. Only explicitly permitted model, bridge, gateway, companion and `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` credentials are accepted. Unset unrelated provider credentials before running; forbidden variable **names**, not values, are reported. Do not pass Langfuse keys into `eve eval`: eve's existing gate remains unchanged.

HTTP execution sends the objective verbatim to `POST /api/v1/runs`, with one UUID idempotency key per start attempt. A 409 retains the same key; a 502 frees the receipt and mints a fresh key. A 422 never retries. Missing bridge secret surfaces as configuration error `agent_bridge_unavailable`.

The primary stream is NDJSON ChatFrame; SSE `data:` lines are accepted for compatibility. The shared application `ChatAccumulator` handles block/delta replay. Tool-start input is retained independently of settled result payloads. The database-backed GET run endpoint confirms terminal state, and polling is the fallback when streaming fails. Stream diagnostics remain in the result; polling cannot reconstruct missing tool arguments.

**Live fixtures are not injected into the app.** Chat-grounding and desirable-output assertions mirror the existing eve suites, but their expected documents/tasks must exist in the local workspace. The authored transcripts in `tests/fixtures/langgraph-transcripts.ts` establish scoring regressions only, not live model behavior or reconciliation evidence.

## Reconciliation handoff

The graph is `prepare → drive → observe → score → reconcile`. Scoring and verification outcomes are independent, including red evals. `createCaseGraph` accepts `verify` and `captureStdout` adapters for the verification runner; these are intentionally not defaulted to fabricated evidence. Without the verification adapter live reconciliation is `pending`; `--skip-reconcile` is explicit `skipped`, not passed. A successful adapter result without captured app stdout is downgraded to pending.

`src/verify/` ships the runner in five small modules: `reconcile.ts` holds the pure, fixture-testable header, event-ordering, tool-lifecycle, redaction and cost checks plus the typed sixth Langfuse check; `db.ts` owns read-only workspace-scoped Postgres fetchers over `agent_runs`/`run_events`/`tool_calls` (plus settled spend and the critique outbox event — never the unwired runtime tables); `langfuse.ts` pages observations v2 by cursor and refuses to run without local keys; `verify.ts` composes them into the graph's verify adapter; `stdout.ts` supervises and window-slices the `next dev` capture; `report.ts` renders the console table and JSON report. The CLI wires them with `DATABASE_URL` (read-only), the `LANGFUSE_*` keys, and an optional `POLYMATH_EVAL_WORKSPACE_ID` override that fails any run row from a different workspace. Release promotion remains blocked until a real live HTTP run passes all six groups with the stdout window on the integrated release head. Missing credentials do not waive that gate.

CLI exit codes: 0 for passing gates (or soft-only results without `--strict`), 1 for failed gates/reconciliation or strict scored verdicts, 2 for configuration errors or pending live verification. `--skip-reconcile` does not imply promotion readiness.

## Mirror checklist and source evidence

- Routing: allowlist size/fallback, routine and hard choices, off-list rejection, fallback flag. `src/cases/routing.case.ts` and `src/drive/fixtures.ts`.
- Approval: five `EXPECTED_POLICY` rows, risk routing/status/classifier agreement, all three criterion descriptions, external-write policy and `gmail.undeclared → deny`. `src/cases/approval-classifier.case.ts`.
- Grounding: document tool, lease mention, literal `2,400`, and original absence-property regex. `src/cases/chat-grounding.case.ts`.
- Desirable outputs: proposal tool, verbatim leading/tail paste, draft framing, no creation claim; both task tools, completed/today-due titles, no missing-records opener. `src/cases/desirable-outputs.case.ts`.

Transport evidence inspected for this implementation: `src/app/api/v1/runs/[runId]/stream/route.ts` GET proxies eve NDJSON (lines 19–35, 93–108) and emits `application/x-ndjson` (211, 242–245); `src/domains/agents/stream-contract.ts` `ChatFrame` (25–44) defines tool start-vs-result payloads (33–34). The run API `startRun` schema (`src/app/api/v1/runs/route.ts:30–41`) accepts no stubs/fixture fields. `createEveDriver().start` (`src/domains/agents/eve-driver.ts:190–209`) sends only message, optional specialist context and operation ID. No app/runtime fixture injection seam is used or added.

## Langfuse v4 SDK handoff

The merged stack uses Langfuse **v4**, not the original v3 assumption. The harness declares `@langfuse/client ^5.11.1` (lockfile resolves **5.14.0**) and removes the unused legacy `langfuse 3.39.2` dependency. These package names and major versions are not interchangeable. The client supports API reads; it does not itself install an OTel span processor or prove export.

The verification adapter should use `new LangfuseClient({ publicKey, secretKey, baseUrl }).api.observations.getMany(...)`: bound queries by `sessionId = agent_runs.session_ref`, `fromStartTime` and `toStartTime`; request `core,basic,model,usage,metadata,trace_context`; follow `meta.cursor` until absent. Group observation rows by `traceId`, check model-call counts against usage events, and retain the application run ID/case ID in the local report. A trace name alone is not correlation proof. Never substitute legacy `api.trace.list/get` response shapes for observations v2.

The instrumentation's `@langfuse/otel` also resolves **5.14.0**. Its installed `dist/index.mjs` exporter targets `/api/public/otel/v1/traces` with Basic auth and supports `additionalHeaders`, but does **not** set `x-langfuse-ingestion-version: 4` by default. Existing agent wiring passes no options. The instrumentation owner must validate the header and complete-span/session propagation on a real integrated-head run; no existing eve files are changed here. Official v4 guidance requires the header plus complete spans and per-observation context, not just the endpoint. Docker boot, actual exported spans, model counts and `session_ref` correlation are still unverified.

Sources fetched 2026-10-30 (full pages, not search snippets): [v4 upgrade FAQ](https://langfuse.com/faq/all/upgrade-to-langfuse-v4) sets the modern JS SDK floor at 5.4.0; [deprecated API migration](https://langfuse.com/faq/all/deprecated-api-migration) specifies observations v2/cursor reads and requires self-hosted >=4.59.0 for JS SDK v6; [OTel migration](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4) specifies the v4 header, propagation and complete immutable spans. Stay on scoped SDK v5 until the actual server minor supports v6.

## Tests

From the repo root:

```sh
pnpm exec vitest run tests/unit/langgraph-*.test.ts
make check
```

Tests cover named-field loader errors and duplicate IDs; real eve matcher score parity, severity/threshold/error semantics and strict exit codes; all case assertions against deterministic observations or authored transcripts; mocked 201/422/409/502/503 HTTP paths, NDJSON/SSE UTF-8/replay/settled-tool input, polling/auth; and broken datasets for each initial reconciliation group. Backend-only: no rendered application UI changes; third-party Studio is not a Polymath visual acceptance criterion.
