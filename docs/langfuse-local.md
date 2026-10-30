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

1. Base app: `docker compose up -d` → `pnpm db:migrate` → `pnpm dev` and
   `eve dev` (dev-user auth; see `.env.example` for the base env).
2. Tracing: `make langfuse-up` — the first boot pulls images and runs
   migrations; the UI is ready when <http://127.0.0.1:3100> answers.
3. Keys: sign up once in the UI, create an organization and a project, then
   Settings → API Keys → create new keys. You get `pk-lf-…` and `sk-lf-…`.
4. Export the harness credentials:

   ```bash
   export LANGFUSE_PUBLIC_KEY=pk-lf-…
   export LANGFUSE_SECRET_KEY=sk-lf-…
   export LANGFUSE_BASE_URL=http://127.0.0.1:3100
   ```

5. Run evals: `make evals` — the LangGraph harness; fixture-only by default, live suites need `GEMINI_API_KEY` (see `evals-langgraph/README.md`).

## Makefile targets

| Target | Does |
|---|---|
| `make langfuse-up` | `docker compose -f compose.langfuse.yaml up -d` |
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
