# `make check` is the project's gate. It calls the same
# script CI runs, so "passing" has exactly one definition.
#
# Local development is one command:
#   make up      # start everything (infra + migrate + web + worker + langfuse)
#   make down    # stop everything
#   make logs    # follow web and worker logs

COMPOSE := docker compose
LANGFUSE_COMPOSE := docker compose -f compose.langfuse.yaml

.PHONY: install dev migrate check e2e search-up search-down search-logs \
	langfuse-up langfuse-down langfuse-logs evals \
	queue-up queue-down queue-logs eve-up eve-down eve-logs eve-status eve \
	local-stack-up local-stack-down up down logs restart seed-taxonomy \
	inventory inventory-check

install:
	pnpm install

# Applies pending forward-only migrations to DATABASE_URL (read from .env).
# Normally `make up` runs migrations automatically in Docker before web/worker.
migrate:
	pnpm db:migrate

# Host-mode Next.js dev server (advanced). Normal local workflow: `make up`.
dev:
	pnpm dev

check:
	pnpm check

# Regenerates docs/generated/inventory.md from the tree. The fact half of the
# technical spec; run it whenever a schema, route, tool, or topic changes.
inventory:
	pnpm exec tsx scripts/tech-spec-inventory.ts

# Fails if the generated inventory is stale. `make check` runs this, so a schema
# change without a regenerated inventory cannot pass the gate.
inventory-check:
	pnpm exec tsx scripts/tech-spec-inventory.ts --check

# Needs the dev server, or E2E_BASE_URL pointing at one.
e2e:
	pnpm e2e

# One command, end to end: app dependencies, Langfuse, migrations, Next.js web
# app, and the outbox worker — all in Docker. No separate queue/dev/stack steps.
up:
	@test -f scripts/local-search/searxng/settings.yml || \
		sed "s/__SEARXNG_SECRET__/$$(openssl rand -hex 32)/" \
			scripts/local-search/searxng/settings.yml.tpl > scripts/local-search/searxng/settings.yml
	$(LANGFUSE_COMPOSE) up -d
	$(COMPOSE) up -d --build --remove-orphans
	@echo ""
	@echo "Axiom is starting:"
	@echo "  web       http://127.0.0.1:3000"
	@echo "  dozzle    http://127.0.0.1:9999  (container logs)"
	@echo "  langfuse  http://127.0.0.1:3100  (pk-lf-polymath-local / sk-lf-polymath-local)"
	@echo ""
	@echo "Useful commands:"
	@echo "  make logs   follow web + worker logs"
	@echo "  make down   stop everything (volumes kept)"

down:
	$(COMPOSE) down --remove-orphans
	$(LANGFUSE_COMPOSE) down
	@echo "stack stopped (volumes kept) — docker compose down -v resets app data"

restart:
	$(COMPOSE) up -d --build web worker

logs:
	$(COMPOSE) logs -f --tail=100 web worker migrate

# Compatibility aliases. Prefer `make up` / `make down` / `make logs`.
local-stack-up: up
local-stack-down: down
queue-up:
	@echo "The outbox worker runs in Docker now. Use: make up"
queue-down:
	@echo "Use: make down  (or: docker compose stop worker)"
queue-logs:
	$(COMPOSE) logs -f --tail=100 worker

# SearXNG + Firecrawl. `make up` starts these; use these targets for the search
# stack only.
search-up:
	@test -f scripts/local-search/searxng/settings.yml || \
		sed "s/__SEARXNG_SECRET__/$$(openssl rand -hex 32)/" \
			scripts/local-search/searxng/settings.yml.tpl > scripts/local-search/searxng/settings.yml
	$(COMPOSE) up -d searxng firecrawl
	@echo "searxng  http://127.0.0.1:8080"
	@echo "firecrawl http://127.0.0.1:3002"

search-down:
	$(COMPOSE) rm -sf searxng firecrawl firecrawl-playwright firecrawl-postgres firecrawl-rabbitmq redis-search

search-logs:
	$(COMPOSE) logs -f searxng firecrawl

# Eve, the agent runtime. `pnpm dev`/web already mounts it through `withEve`
# (next.config.ts), so for local app testing there is nothing to start — and
# a second eve for the same agent refuses to boot ("A dev server is already
# running"). These targets are for the agent-only loop when Next is stopped.
eve:
	cd eve/polymath && eve dev

eve-up:
	pnpm exec tsx scripts/eve-dev.ts up

eve-down:
	pnpm exec tsx scripts/eve-dev.ts down

eve-status:
	pnpm exec tsx scripts/eve-dev.ts status

eve-logs:
	@test -f .run/eve-dev.log || { echo "no eve log yet — make eve-up first"; exit 1; }
	tail -n 100 -f .run/eve-dev.log

# Self-hosted Langfuse (compose.langfuse.yaml) — eval loop trace store.
# `make up` starts it; these targets manage it directly. Own compose project and
# own Postgres; the app stack is never touched. UI on 127.0.0.1:3100.
langfuse-up:
	$(LANGFUSE_COMPOSE) up -d
	@printf "waiting for langfuse"
	@for i in $$(seq 1 90); do \
		curl -sf --max-time 3 http://127.0.0.1:3100/api/public/health >/dev/null 2>&1 && { echo " ready"; break; }; \
		printf "."; sleep 2; \
	done
	@curl -sf --max-time 3 http://127.0.0.1:3100/api/public/health >/dev/null 2>&1 || \
		{ echo " not ready — make langfuse-logs"; exit 1; }
	@echo "langfuse  http://127.0.0.1:3100"
	@echo "keys      pk-lf-polymath-local / sk-lf-polymath-local (LANGFUSE_BASE_URL=http://127.0.0.1:3100)"

langfuse-down:
	$(LANGFUSE_COMPOSE) down

langfuse-logs:
	$(LANGFUSE_COMPOSE) logs -f langfuse-web langfuse-worker

# LangGraph eval harness (evals-langgraph/). Fixture-only by default.
evals:
	cd evals-langgraph && pnpm eval

# ASH-272: seed the knowledge taxonomy catalog. Dry run; -- --apply writes.
seed-taxonomy:
	pnpm seed:taxonomy
