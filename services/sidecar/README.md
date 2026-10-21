# polymath-sidecar

Python capability sidecar for Polymath — see `docs/adr/0008-python-sidecar.md`.
FastAPI + SQLAlchemy (async) on the same Neon database, with its own state in
the Postgres schema `sidecar` and pgvector available for batch embedding work.

It is a capability service, not a second orchestrator: Eve stays the single
orchestrator, and authority, canonical schema and external effects stay in the
Next.js app.

## Local development

With docker (from the repo root):

```sh
docker compose up -d db sidecar
```

Bare metal:

```sh
cd services/sidecar
pip install -e '.[dev]'
export SIDECAR_TOKEN=dev-token
export DATABASE_URL=postgresql+asyncpg://axiom:axiom@localhost:5432/axiom
uvicorn app.main:create_app --factory --reload
```

## Tests

```sh
pytest                    # unit tests (SQLite)
SIDECAR_TEST_DATABASE_URL=postgresql+asyncpg://axiom:axiom@localhost:5432/axiom \
  pytest tests/test_embeddings_pg.py   # pgvector round-trip
```

## API

- `GET /healthz` — unauthenticated liveness.
- `POST /v1/jobs` — bearer-authed, workspace-scoped job intake. Body:
  `{workspace_id, kind, payload, idempotency_key}`. One effect per
  `(workspace_id, idempotency_key)`; a replay returns the original row.
- `GET /v1/jobs/{id}?workspace_id=...` — bearer-authed, workspace-scoped read.

Auth: `Authorization: Bearer $SIDECAR_TOKEN`. The service fails closed (503 on
`/v1/*`) when the token is unset. The browser never calls this service.
