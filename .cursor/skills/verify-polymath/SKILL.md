---
name: verify-polymath
description: Verify Polymath end to end. Launch the Next.js dev server against the sandbox Postgres, drive user-facing features with the repo's own Playwright harness, and capture proof. Use before declaring UI work done, to reproduce a defect on the real surface, or to gather evidence for a visual change.
---

# Verify Polymath

Polymath is a Next.js app (App Router, React 19, Drizzle over Postgres). A signed-in user lands on the Assistant conversation at `/polymath`. This skill launches the app in this sandbox, drives it with the repo's own Playwright, and leaves evidence.

It ships exactly one script: the drive block in Drive. State seeding goes through the repo's own e2e helpers, and every journey in `features/` names the spec that owns it in CI.

## Launch

Launch is done when the app is reachable, signed in, and past the first-run gate on `http://localhost:3000`.

1. Check the environment. Launch reads `.env` at the repo root. It must define:

   - `DATABASE_URL`, pointing at the migrated QA database. In this sandbox that is `polymath_qa` on Postgres 17 at `127.0.0.1:5432` (superuser `axiom`).
   - `TEST_DATABASE_URL`, pointing at the scratch database (`polymath_test`). The integration suite truncates it. Never point it at the same database as `DATABASE_URL`.
   - `POLYMATH_DEV_AUTH=1`, which skips Clerk sign-in and resolves a fixed `dev-user` owner (`src/lib/clerk.ts`). It stands down when `NODE_ENV=production`, so it cannot open a deployment.
   - `EVE_BRIDGE_SECRET` and `EVE_GATEWAY_SECRET`, locally minted. Without them `POST /api/v1/runs` answers 503 `agent_bridge_unavailable`.

   The file is gitignored. On a fresh sandbox, write these keys before anything else. Then load it into the current shell and fail fast if the connection string is missing:

   ```sh
   set -a; . ./.env; set +a; : "${DATABASE_URL:?DATABASE_URL is required}"
   ```

   Every later `psql "$DATABASE_URL"` in this skill assumes that load. Without it, psql falls back to its default database instead of the app database.

2. Confirm Postgres is up. `pg_isready -h 127.0.0.1 -p 5432` must report `accepting connections`.

3. If `polymath_qa` is missing or has no tables, create and migrate it:

   ```sh
   psql -h 127.0.0.1 -U axiom -c 'create database polymath_qa'
   pnpm db:migrate
   ```

4. Stamp the dev owner so the first-run gate never redirects to `/onboarding`. Run the same upserts as `tests/e2e/global-setup.ts`. They are `on conflict` statements, so re-running is safe:

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
   insert into users (clerk_user_id) values ('dev-user')
     on conflict (clerk_user_id) do update set updated_at = now();

   insert into workspaces (name, slug, is_personal, onboarded_at)
     select 'Personal', 'personal-' || u.id::text, true, now()
     from users u where u.clerk_user_id = 'dev-user'
     on conflict (slug) do update
       set onboarded_at = coalesce(workspaces.onboarded_at, now());

   insert into memberships (workspace_id, user_id, role, status)
     select w.id, u.id, 'owner', 'active'
     from users u join workspaces w on w.slug = 'personal-' || u.id::text
     where u.clerk_user_id = 'dev-user'
     on conflict (workspace_id, user_id) do nothing;
   SQL
   ```

5. Start the server in its own tmux session. The runtime must be Node 24 or newer. `next.config.ts` wraps the app in `withEve`, which unconditionally spawns an Eve dev server per agent, and Eve exits on older Node with `eve requires Node.js >=24` — taking the whole launch with it. `pnpm exec next dev` does not avoid this: it loads the same config. This sandbox ships Node 20 on `PATH`, so install a local Node 24 once and prefix it:

   ```sh
   node --version   # printed v20.20.2 here; the repo needs v24 or newer
   mkdir -p /home/user/work/tools
   curl -fsSL https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz -o /tmp/node24.tar.xz
   tar -xJf /tmp/node24.tar.xz -C /home/user/work/tools
   tmux new-session -d -s polymath-dev \
     'PATH=/home/user/work/tools/node-v24.22.2-linux-x64/bin:$PATH pnpm dev'
   ```

   Under Node 24 the launch boots Next plus both Eve dev servers; their `server listening at http://127.0.0.1:…` lines in the tmux pane are the bridge config working. The first request to a route pays its compile, so give the readiness check time.

6. Poll for readiness:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/polymath
   ```

   `200` means ready. Until the server listens, `curl` exits 7 (connection refused).

## Doctor

One read-only pass answers "is this instance worth driving?" Run it first whenever anything looks off, from a shell that has loaded `.env` (Launch step 1): an unset `DATABASE_URL` sends psql to its default database.

```sh
pg_isready -h 127.0.0.1 -p 5432
tmux ls
ss -ltnp | grep :3000
psql "$DATABASE_URL" -tAc "select count(*) from information_schema.tables where table_schema = 'public'"
psql "$DATABASE_URL" -tAc "select id from users where clerk_user_id = 'dev-user'"
grep -c '^POLYMATH_DEV_AUTH=1' .env
```

Read the results:

- Postgres not accepting connections: start Postgres, then run Launch step 3.
- No `polymath-dev` session in `tmux ls`: the server died. Read the tail with `tmux capture-pane -t polymath-dev -p | tail -40` before restarting.
- The port is owned by a `next-server` process but no `polymath-dev` session exists: an orphan from an earlier session. Kill that pid, then launch your own; a fresh server on the same port fails while it is held.
- Public table count near zero: the QA database is not migrated. Run `pnpm db:migrate`.
- No `dev-user` row: run the stamp block from Launch step 4. Without it the first-run gate redirects every journey to `/onboarding`.
- `grep` count 0: dev auth is off and screens hit Clerk. Fix `.env`, then restart the server from the repo root so Next reads it.

## Drive

Drive the app the way a user does, with the repo's own Playwright (`playwright` and its Chromium ship for `tests/e2e`). Write the script under `/home/user/work/`, not in the checkout, and resolve the repo's Playwright against the repo's package.json:

```js
import { createRequire } from "node:module";
const { chromium } = createRequire("/home/user/work/Polymath/package.json")("playwright");

const RUN_ID = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://localhost:3000/polymath/${RUN_ID}`, { waitUntil: "load" });
await page.getByText("<objective>", { exact: false }).first().waitFor({ timeout: 20000 });
console.log((await page.locator("body").innerText()).includes("This conversation has no messages yet."));
await page.screenshot({ path: "/home/user/work/evidence/verify-polymath/tc-1-detail.png" });
await browser.close();
```

Run it from the repo root so module resolution finds the repo: `node /home/user/work/drive.mjs <runId>`. Assert on rendered text a user reads, and look at the captures before calling anything verified.

Stable handles, taken from `tests/e2e` (the suite that owns these journeys in CI):

- `#content` is the workspace content main. Scope assertions to `page.locator("#content").first()`; in dev the streamed subtree can be mounted twice.
- Assistant home: `#content h1` reads "What would you like to work on?". The composer is a textbox named "Start a conversation", placeholder "Ask anything or describe a task…". History rows sit under "YOUR CONVERSATIONS", bucketed by day (history.ts), and the row title is `displayTitle(stripMentionContext(run.objective))` — the objective a seed inserts is the text the row shows.
- Conversation detail: `#content h1` is the objective. Region "Conversation". An empty run reads "This conversation has no messages yet.".
- History rows carry no status words. Reviews owns the waiting-on-you vocabulary; the conversation screens never show "Running", "Succeeded", or "Needs your reply".
- `/polymath/*` screens are headerless. There is no "Search workspace" trigger there, so never wait on one.

Seed state through the repo's own pattern, never through the UI when the state needs a model. `tests/e2e/helpers/runs.ts` inserts rows into `agent_runs` (objective, state, the dev owner's workspace) and registers every row for deletion. `waiting_approval` and `waiting_input` are reachable only as seeded rows: the product reaches them after a model asks for a proposal, and this sandbox has no model provider. Starting a run through the composer or `POST /api/v1/runs` (body `{"objective": "..."}`, header `Idempotency-Key: <uuid>`) exercises the start path and the bridge config, but its transcript will not progress without a provider key.

The feature map in `features/` names the surface, the route, and the specs that own each journey. Pick the file for what you are verifying.

## Evidence

Capture to `/home/user/work/evidence/verify-polymath/`. Create the directory before driving. It sits outside the checkout, so nothing lands in git by accident.

- Name captures `tc-N-<what>.png`. One result capture per verified behavior, or a before and after pair when the visual change is the point.
- Record a short WebM only for an interaction worth watching.
- Verify side effects beside the screen: the run id in the URL matches the seeded row, a created note survives a reload, a deleted row is gone from `agent_runs`.
- The drive script's JSON line and exit code are not the verdict. Look at the captures (view the PNGs) before calling a behavior proven.
- Evidence survives cleanup by design. Cleanup deletes processes and seeded rows, never this directory.
- Check captures for secrets before uploading them anywhere.

## Cleanup

Kill only what you started.

- Server: `tmux kill-session -t polymath-dev`, then confirm the port is free (`ss -ltnp | grep :3000` prints nothing).
- Seeded rows: delete by the ids you inserted. A bare seeded run deletes directly; ten tables hold `agent_runs` foreign keys (steps, events, tool calls, reviews…), so a run that accumulated model output needs its children deleted first. If you used `seedRun`, its `removeSeededRuns()` is the pattern. Never truncate `polymath_qa`; it holds the shared QA data.
- Scratch databases: drop only ones you created for a journey.
- After cleanup, run `ls /home/user/work/evidence/verify-polymath/` and confirm the captures are still there. A cleanup that eats the proof failed.

## Helpers

The harness is the repo's own; read it before writing anything new:

- `tests/e2e/helpers/runs.ts` owns `seedRun({ objective, state })` and `removeSeededRuns()`, direct inserts into `agent_runs` with cleanup registration.
- `tests/e2e/helpers/settled.ts` owns `waitSettled(page)`, which waits out hydration before axe or click assertions.
- `tests/e2e/helpers/database.ts`, `proposals.ts`, `tasks.ts`, and `invoice-pdf.ts` are the other seeded-state builders.
- `tests/e2e/global-setup.ts` holds the dev-owner upserts that Launch step 4 mirrors.
- `playwright.config.ts` is the CI harness. `pnpm e2e` runs `tests/e2e` as an explicit 3-way shard, and each shard boots its own dev server against its own database.
- `make check` is the CI gate: lint, typecheck, unit tests, inventory check, production build.
