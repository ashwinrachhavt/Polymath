# Langfuse (local, self-hosted)

`compose.langfuse.yaml` runs [Langfuse](https://langfuse.com) — the trace
store the LangGraph eval loop reads and writes. It is a companion stack: own
compose project (`polymath-langfuse`) and its own Postgres, so `docker
compose up -d` (the app stack in `compose.yaml`) and the app database are
never touched — the same isolation the Firecrawl stack got.

Service set, image tags, and env names follow the official self-hosting
reference: langfuse.com/self-hosting/docker-compose and `docker-compose.yml`
on `langfuse/langfuse` (retrieved 2026-10-30 — `langfuse:4` /
`langfuse-worker:4` from `docker.langfuse.com`; the eval-system spec's "v3"
note predates the v4 images, the six-service topology is unchanged). Health
endpoints per langfuse.com/self-hosting/configuration/health-readiness-endpoints.

## Services & ports (all loopback-only)

| Service | Host port | Purpose |
|---|---|---|
| `langfuse-web` | 3100 | UI + SDK/OTel ingestion (3000 is `next dev`'s) |
| `langfuse-worker` | 3030 | worker health port (`/api/health`) |
| `langfuse-postgres` | 5433 | Langfuse's own Postgres (5432 is the app db) |
| `langfuse-clickhouse` | 8123, 9000 | trace storage (HTTP, native) |
| `langfuse-minio` | 9090, 9091 | blob storage API, console |
| `langfuse-redis` | 6379 | queue backend (healthcheck: authenticated `PING`, reply must be exactly `PONG`) |

## Boot order (fresh machine)

1. Base app: `docker compose up -d` → `pnpm db:migrate` → `pnpm dev`
   (dev-user auth; see `.env.example` for the base env). `pnpm dev` mounts
   the agents through `withEve`, so eve starts with it; `make eve` is only for
   an agent-only loop with Next stopped.
2. Tracing: `make langfuse-up` — the first boot pulls images and runs
   migrations; `--wait` returns once the web container is healthy.
3. Keys: no signup step. The compose file headless-initializes one org, one
   project and a fixed key pair on first boot, so the keys are already known.
   Export them in the app shell, the eve shell and the harness shell:

   ```bash
   export LANGFUSE_PUBLIC_KEY=pk-lf-polymath-local
   export LANGFUSE_SECRET_KEY=sk-lf-polymath-local
   export LANGFUSE_BASE_URL=http://127.0.0.1:3100
   ```

   They are loopback-only placeholders like the db's `axiom`/`axiom`; mint real
   keys in the UI if you want per-person attribution, or rotate the
   `LANGFUSE_INIT_*` values in the compose file (they only apply on a first
   boot — wipe the volumes with `docker compose -f compose.langfuse.yaml down -v`
   to re-initialize).

4. Run evals: `make evals` — the LangGraph harness; fixture-only by default, live suites need `GEMINI_API_KEY` (see `evals-langgraph/README.md`).

`make local-stack-up` does steps 1–3's long-running halves in one command
(app dependencies + the Langfuse stack; `make dev` still starts Next and eve)
and prints the three exports; `make local-stack-down` stops them and keeps the
volumes.

## Makefile targets

| Target | Does |
|---|---|
| `make langfuse-up` | start the stack and wait for health; prints the key placeholders |
| `make langfuse-logs` | follow `langfuse-web` + `langfuse-worker` logs |
| `make langfuse-down` | stop and remove the stack (volumes survive; add `-v` by hand to wipe) |

## Credentials & privacy

The compose file's passwords and salts are placeholders for a loopback-only
stack (same stance as the app db's `axiom`/`axiom`), outbound telemetry is
off, and every published port binds `127.0.0.1`. Before exposing anything
beyond this machine, regenerate the placeholders with `openssl rand -hex 32`
and put the stack behind a firewall.

### Why no `.env.example` entry

`LANGFUSE_*` keys are credential-shaped: eve's eval environment gate
(`eve/polymath/evals/stubs.ts`) throws when a credential-shaped variable is
set outside its allowlist. The LangGraph harness keeps its **own** gate whose
allowlist includes the `LANGFUSE_*` keys, so the two gates stay independent —
a Langfuse-side misconfiguration can never trip eve's gate, and eve eval runs
stay clean of tracing credentials.
