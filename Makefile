# `make check` is the project's gate. It calls the same
# script CI runs, so "passing" has exactly one definition.

.PHONY: install dev check e2e search-up search-down search-logs langfuse-up langfuse-down langfuse-logs evals queue-up queue-down queue-logs eve-up eve-down eve-logs eve-status eve local-stack-up local-stack-down seed-taxonomy

install:
	pnpm install

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

# SearXNG + Firecrawl. First run generates the SearXNG settings with a local
# secret; compose pulls the images. Bound to 127.0.0.1 only.
search-up:
	@test -f scripts/local-search/searxng/settings.yml || \
		sed "s/__SEARXNG_SECRET__/$$(openssl rand -hex 32)/" \
			scripts/local-search/searxng/settings.yml.tpl > scripts/local-search/searxng/settings.yml
	docker compose up -d searxng firecrawl
	@echo "searxng  http://127.0.0.1:8080"
	@echo "firecrawl http://127.0.0.1:3002"

search-down:
	docker compose rm -sf searxng firecrawl firecrawl-playwright firecrawl-postgres firecrawl-rabbitmq redis-search

search-logs:
	docker compose logs -f searxng firecrawl

# The outbox drain. Uploads and crawls queue work in the database; nothing moves
# without this process. Runs on the host (it imports src/, so it needs the repo
# and its node_modules, not a container image).
queue-up:
	@mkdir -p .run
	@nohup pnpm exec tsx --env-file=.env scripts/outbox-worker.ts >> .run/outbox-worker.log 2>&1 & echo $$! > .run/outbox-worker.pid
	@echo "outbox worker started (pid $$(cat .run/outbox-worker.pid)) - make queue-logs to follow"

queue-down:
	@test -f .run/outbox-worker.pid && kill $$(cat .run/outbox-worker.pid) 2>/dev/null || true
	@rm -f .run/outbox-worker.pid
	@echo "outbox worker stopped"

queue-logs:
	@tail -f .run/outbox-worker.log

# Eve, the agent runtime. `pnpm dev` already mounts it through `withEve`
# (next.config.ts), so for local app testing there is nothing to start — and
# a second eve for the same agent refuses to boot ("A dev server is already
# running"). These targets are for the agent-only loop when Next is stopped.
# `make eve` is the interactive foreground TUI; `eve-up` is the unattended
# one (bounded log + pid in .run/, like the outbox worker) and beside a
# running `pnpm dev` it reports the instance Next already serves.
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

# One command for local app testing: the Langfuse trace store, plus the app
# dependencies if they are not up yet (db, docling, search). eve needs no
# target here — `pnpm dev` starts it. Prints the exports eve and the harness
# need for tracing. `make dev` still runs the Next server itself; stop the
# stack with local-stack-down, which leaves the db volume (a reset is still
# `docker compose down -v`, deliberately not wired to a make target).
local-stack-up:
	docker compose up -d --wait db docling
	$(MAKE) langfuse-up
	@echo ""
	@echo "export LANGFUSE_PUBLIC_KEY=$${LANGFUSE_PUBLIC_KEY:-pk-lf-polymath-local}"
	@echo "export LANGFUSE_SECRET_KEY=$${LANGFUSE_SECRET_KEY:-sk-lf-polymath-local}"
	@echo "export LANGFUSE_BASE_URL=$${LANGFUSE_BASE_URL:-http://127.0.0.1:3100}"
	@echo ""
	@echo "next: make dev   (it starts eve too; export the lines above in that shell for tracing)"

local-stack-down: langfuse-down
	docker compose stop db docling
	@echo "app dependencies stopped (volumes kept) — docker compose down -v resets them"

# Self-hosted Langfuse (compose.langfuse.yaml) — the eval loop's trace store.
# Own compose project and own Postgres; the app stack in compose.yaml is
# never touched. Loopback-only; UI on 3100 because 3000 is next dev's.
# First boot headless-initializes the org, project and API keys, so there is
# no signup step: the keys are the pk-/sk- placeholders in the compose file.
# Keys and the boot order: docs/langfuse-local.md.
# Wait on the public endpoint, not `up --wait`: the containers' own healthchecks
# have a history of reporting "connection refused" long after the server answers
# (observed on a cold boot), which turns --wait into a 5-minute failure. What
# the harness and the tracing exporter need is 3100 answering, so that is the gate.
langfuse-up:
	docker compose -f compose.langfuse.yaml up -d
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
	docker compose -f compose.langfuse.yaml down

langfuse-logs:
	docker compose -f compose.langfuse.yaml logs -f langfuse-web langfuse-worker

# LangGraph eval harness (evals-langgraph/). Fixture-only by default: routing
# and approval-classifier run deterministically with no model keys and no app
# records. Live suites (chat-grounding, desirable-outputs) additionally need
# GEMINI_API_KEY and a running app; see evals-langgraph/README.md.
evals:
	cd evals-langgraph && pnpm eval

# ASH-272: seed the knowledge taxonomy catalog. Dry run; -- --apply writes.
seed-taxonomy:
	pnpm seed:taxonomy
